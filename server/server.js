'use strict';
require('dotenv').config();

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// ── Config ─────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.PORT ?? '3000', 10);
const WEBHOOK_URL  = process.env.DISCORD_WEBHOOK_URL ?? '';
const BOT_TOKEN    = process.env.DISCORD_BOT_TOKEN  ?? '';
const CHANNEL_ID   = process.env.DISCORD_CHANNEL_ID ?? '';
const SESSION_DIR  = path.join(__dirname, 'sessions');

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

// ── Session State ──────────────────────────────────────────────────────────

/** @type {Session} */
let session = makeEmptySession();

function makeEmptySession(name = '') {
  return {
    id:         null,
    name:       name || '',
    startedAt:  null,
    endedAt:    null,
    rolls:      [],   // RollEntry[]
    characters: {},   // handle → CharacterData
  };
}

function sessionActive() { return !!session.id; }

function saveSessionToDisk() {
  if (!session.id) return;
  const file = path.join(SESSION_DIR, `${session.id}.json`);
  fs.writeFileSync(file, JSON.stringify(session, null, 2), 'utf-8');
}

// ── Discord Webhook ────────────────────────────────────────────────────────

async function webhookPost(payload) {
  if (!WEBHOOK_URL) return;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) console.warn('[webhook]', res.status, await res.text());
  } catch (e) {
    console.warn('[webhook] error:', e.message);
  }
}

// ── Discord Embed Formatters ───────────────────────────────────────────────

function rollEmbed(roll) {
  const {
    player = '未知玩家', character = '', type, label = '',
    rollVal, chainRolls = [], modifier = 0, total,
    dv, success, critical, fumble,
  } = roll;

  let color = 0x444444;
  if (critical)   color = 0xff0033;
  else if (fumble) color = 0xff6600;
  else if (success === true)  color = 0x00e676;
  else if (success === false) color = 0xff3d00;

  let title = '';
  if (critical && success) title = '⚡ 暴击成功 CRITICAL';
  else if (fumble)          title = '☠ 致命失误 FUMBLE';
  else if (success === true)  title = '✅ 成功 SUCCESS';
  else if (success === false) title = '❌ 失败 FAILURE';
  else title = '🎲 ' + label;

  const who = character ? `**${player}** (${character})` : `**${player}**`;

  let diceStr = String(rollVal);
  if (chainRolls.length) {
    const sign = critical ? '+' : '-';
    diceStr += chainRolls.map(r => ` ${sign}${r}`).join('') + ' (链式爆炸)';
  }

  const fields = [
    { name: '骰子',   value: diceStr,           inline: true },
    { name: '修正值', value: `+${modifier}`,     inline: true },
    { name: '合计',   value: `**${total}**`,     inline: true },
  ];

  if (dv != null) {
    const diff = total - dv;
    fields.push(
      { name: 'DV',   value: String(dv), inline: true },
      { name: '差值', value: (diff >= 0 ? '+' : '') + diff, inline: true },
    );
  }

  return {
    title,
    description: `${who} — ${label}`,
    color,
    fields,
    footer: { text: 'NIGHT CITY // NETRUNNER DICE' },
    timestamp: new Date().toISOString(),
  };
}

function characterEmbed(char) {
  const { handle = '?', role = '', stats = {}, notes = '' } = char;
  const hp = 10 + 5 * Math.floor(((stats.BODY ?? 4) + (stats.WILL ?? 4)) / 2);
  const hm = (stats.EMP ?? 4) * 10;
  const ROLES_CN = {
    solo: '孤狼', rockerboy: '摇滚客', netrunner: '网络奇侠',
    tech: '技术专家', medtech: '医疗专家', media: '媒体人',
    lawman: '执法者', exec: '公司经理', fixer: '掮客', nomad: '浪人',
  };
  const roleName = ROLES_CN[role] ? `${ROLES_CN[role]}` : (role || '未知职业');
  const statLine =
    ['INT','REF','DEX','TECH','COOL','WILL','LUCK','MOVE','BODY','EMP']
    .map(k => `${k} **${stats[k] ?? '?'}**`).join(' · ');

  return {
    title:       `📋 角色入场 — ${handle}`,
    description: `**${roleName}**\n${statLine}`,
    color:       0xffcc00,
    fields: [
      { name: 'HP 生命值',   value: String(hp), inline: true },
      { name: '人性值',      value: String(hm), inline: true },
      { name: '死亡豁免',   value: String(stats.BODY ?? 4), inline: true },
      ...(notes ? [{ name: '背景', value: notes.slice(0, 200) }] : []),
    ],
    footer: { text: 'NIGHT CITY // NETRUNNER DICE' },
    timestamp: new Date().toISOString(),
  };
}

// ── Server-side Dice Rolling (for DM bot commands) ────────────────────────

function dieRoll(sides) {
  return Math.floor(Math.random() * sides) + 1;
}

/** Parse "3d6+2", "d10", "2d10-1" etc. Returns { dice, sides, mod, rolls, total } */
function parseDice(notation) {
  const m = /^(\d*)d(\d+)([+-]\d+)?$/i.exec(notation.trim());
  if (!m) return null;
  const dice  = parseInt(m[1] || '1', 10);
  const sides = parseInt(m[2], 10);
  const mod   = parseInt(m[3] || '0', 10);
  if (dice < 1 || dice > 100 || sides < 2 || sides > 1000) return null;
  const rolls = Array.from({ length: dice }, () => dieRoll(sides));
  const total = rolls.reduce((a, b) => a + b, 0) + mod;
  return { dice, sides, mod, rolls, total };
}

/** Exploding d10 skill check. Returns { rollVal, chainRolls, critical, fumble, rawD10Total } */
function explodingD10() {
  const MAX_CHAIN = 10;
  let first = dieRoll(10);
  const chainRolls = [];
  const critical = first === 10;
  const fumble   = first === 1;
  if (critical) {
    let last = first;
    let n = 0;
    while (last === 10 && n++ < MAX_CHAIN) {
      const r = dieRoll(10); chainRolls.push(r); last = r;
    }
  } else if (fumble) {
    let last = first;
    let n = 0;
    while (last === 1 && n++ < MAX_CHAIN) {
      const r = dieRoll(10); chainRolls.push(-r); last = -r; /* negative */
    }
  }
  const extraSum = chainRolls.reduce((a, b) => a + b, 0);
  return { rollVal: first, chainRolls: chainRolls.map(Math.abs), critical, fumble, rawD10Total: first + extraSum };
}

// ── Express App ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' }));

// Serve static files from parent directory (where dice-roller.html lives)
app.use(express.static(path.join(__dirname, '..')));

// CORS for local dev (HTML opened directly from filesystem)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Health Check ──

app.get('/api/ping', (_req, res) => {
  res.json({
    ok: true,
    sessionActive: sessionActive(),
    sessionName: session.name,
    webhookConfigured: !!WEBHOOK_URL,
    botConfigured:     !!BOT_TOKEN,
  });
});

// ── Session Management ──

app.post('/api/session/start', (req, res) => {
  const name = (req.body.name || '').trim() || `Session ${new Date().toLocaleDateString('zh-CN')}`;
  session = makeEmptySession(name);
  session.id        = 'session_' + Date.now();
  session.startedAt = Date.now();
  saveSessionToDisk();
  console.log(`[session] started: ${session.id} "${session.name}"`);
  webhookPost({
    embeds: [{
      title:       '🎲 Session 开始',
      description: `**${session.name}**`,
      color:       0xff0033,
      footer:      { text: 'NIGHT CITY // NETRUNNER DICE' },
      timestamp:   new Date().toISOString(),
    }],
  });
  res.json({ ok: true, session: { id: session.id, name: session.name } });
});

app.post('/api/session/end', (_req, res) => {
  if (!sessionActive()) return res.status(400).json({ error: 'no active session' });
  session.endedAt = Date.now();
  const duration = Math.round((session.endedAt - session.startedAt) / 60000);
  saveSessionToDisk();
  const summary = buildMarkdownSummary(session);
  webhookPost({
    embeds: [{
      title:       '📕 Session 结束',
      description: `**${session.name}**\n时长: ${duration} 分钟 · 投掷: ${session.rolls.length} 次`,
      color:       0xffcc00,
      fields:      [{ name: '摘要', value: summary.slice(0, 1000) }],
      footer:      { text: 'NIGHT CITY // NETRUNNER DICE' },
      timestamp:   new Date().toISOString(),
    }],
  });
  console.log(`[session] ended: ${session.id}`);
  res.json({ ok: true });
  session = makeEmptySession();
});

app.get('/api/session', (_req, res) => {
  res.json({
    active: sessionActive(),
    id:     session.id,
    name:   session.name,
    startedAt: session.startedAt,
    rollCount: session.rolls.length,
    characters: Object.keys(session.characters),
  });
});

// ── Roll Endpoint ──

app.post('/api/roll', async (req, res) => {
  const roll = req.body;
  if (!roll || typeof roll.total !== 'number') {
    return res.status(400).json({ error: 'invalid roll data' });
  }
  const entry = { ...roll, receivedAt: Date.now() };
  if (sessionActive()) {
    session.rolls.push(entry);
    saveSessionToDisk();
  }
  console.log(`[roll] ${roll.player ?? '?'}: ${roll.label ?? ''} → ${roll.total}`);
  await webhookPost({ embeds: [rollEmbed(roll)] });
  res.json({ ok: true });
});

// ── Character Endpoint ──

app.post('/api/character', async (req, res) => {
  const char = req.body;
  if (!char || !char.handle) return res.status(400).json({ error: 'missing handle' });
  if (sessionActive()) {
    session.characters[char.handle] = char;
    saveSessionToDisk();
  }
  console.log(`[character] registered: ${char.handle}`);
  await webhookPost({ embeds: [characterEmbed(char)] });
  res.json({ ok: true });
});

// ── Export Endpoints ──

app.get('/api/export/json', (req, res) => {
  const name = (session.name || 'session').replace(/[^a-z0-9一-龥]/gi, '_');
  res.attachment(`${name}.json`);
  res.json(session);
});

app.get('/api/export/markdown', (req, res) => {
  const name = (session.name || 'session').replace(/[^a-z0-9一-龥]/gi, '_');
  res.attachment(`${name}.md`);
  res.type('text/markdown; charset=utf-8');
  res.send(buildMarkdownSummary(session));
});

function buildMarkdownSummary(s) {
  const lines = [
    `# ${s.name || 'Cyberpunk RED Session'}`,
    `> 开始: ${s.startedAt ? new Date(s.startedAt).toLocaleString('zh-CN') : '—'}`,
    `> 结束: ${s.endedAt  ? new Date(s.endedAt).toLocaleString('zh-CN')  : '进行中'}`,
    '',
    '## 角色',
  ];
  Object.values(s.characters).forEach(c => {
    const hp = 10 + 5 * Math.floor(((c.stats?.BODY ?? 4) + (c.stats?.WILL ?? 4)) / 2);
    lines.push(`- **${c.handle}** (${c.role || '?'}) HP:${hp}`);
  });
  lines.push('', '## 投掷记录', '');
  s.rolls.slice(-100).forEach(r => {
    const t = r.receivedAt ? new Date(r.receivedAt).toLocaleTimeString('zh-CN') : '?';
    const verdict = r.critical ? '⚡暴击' : r.fumble ? '☠失误' : r.success === true ? '✅' : r.success === false ? '❌' : '🎲';
    lines.push(`| ${t} | ${r.player ?? '?'} | ${r.label ?? ''} | ${r.total} | ${verdict} |`);
  });
  return lines.join('\n');
}

// ── Discord Bot (DM Commands) ─────────────────────────────────────────────

if (BOT_TOKEN) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once('ready', () => {
    console.log(`[bot] Logged in as ${client.user.tag}`);
    console.log(`[bot] Watching channel: ${CHANNEL_ID || '(all channels)'}`);
  });

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;
    if (!msg.content.startsWith('!')) return;
    if (CHANNEL_ID && msg.channelId !== CHANNEL_ID) return;

    const raw  = msg.content.slice(1).trim();
    const args = raw.split(/\s+/);
    const cmd  = args[0].toLowerCase();

    try {
      switch (cmd) {

        // !roll 3d6 / !r d10+4
        case 'roll': case 'r': {
          const notation = args[1];
          if (!notation) { await msg.reply('用法: `!roll 3d6` 或 `!roll d10+2`'); break; }
          const result = parseDice(notation);
          if (!result) { await msg.reply('格式错误，示例: `3d6`, `d10`, `2d6+3`'); break; }
          const { dice, sides, mod, rolls, total } = result;
          const modStr = mod !== 0 ? (mod > 0 ? `+${mod}` : `${mod}`) : '';
          const embed = new EmbedBuilder()
            .setTitle(`🎲 DM投掷 — ${dice}d${sides}${modStr}`)
            .setColor(0xff0033)
            .addFields(
              { name: '各骰', value: `[${rolls.join(', ')}]`, inline: true },
              { name: '合计', value: `**${total}**`,          inline: true },
            )
            .setFooter({ text: 'NIGHT CITY // DM' })
            .setTimestamp();
          await msg.reply({ embeds: [embed] });
          if (sessionActive()) {
            session.rolls.push({
              player: `DM (${msg.author.username})`,
              label: `DM: ${dice}d${sides}${modStr}`,
              type: 'custom', rolls, total,
              receivedAt: Date.now(),
            });
            saveSessionToDisk();
          }
          break;
        }

        // !check STAT SKILL DV — exploding d10 skill check
        case 'check': case 'c': {
          const [statVal, skillVal, dvVal] = args.slice(1).map(Number);
          if (isNaN(statVal) || isNaN(skillVal)) {
            await msg.reply('用法: `!check <STAT> <技能> [DV]` 例: `!check 6 4 13`'); break;
          }
          const { rollVal, chainRolls, critical, fumble, rawD10Total } = explodingD10();
          const mod   = statVal + skillVal;
          const total = Math.max(1, rawD10Total + mod);
          const dv    = dvVal ?? null;
          const success = dv != null ? total >= dv : null;

          let title = '🎲 DM技能检定';
          let color = 0x888888;
          if (critical && success !== false) { title = '⚡ 暴击 CRITICAL'; color = 0xff0033; }
          else if (fumble)                   { title = '☠ 失误 FUMBLE';   color = 0xff6600; }
          else if (success === true)  { title = '✅ 成功'; color = 0x00e676; }
          else if (success === false) { title = '❌ 失败'; color = 0xff3d00; }

          let diceStr = String(rollVal);
          if (chainRolls.length) diceStr += chainRolls.map(r => `+${r}`).join('') + '(链)';

          const embed = new EmbedBuilder()
            .setTitle(title).setColor(color)
            .addFields(
              { name: '骰子',   value: diceStr,                 inline: true },
              { name: '修正',   value: `STAT${statVal}+技能${skillVal}`, inline: true },
              { name: '合计',   value: `**${total}**`,          inline: true },
              ...(dv != null ? [{ name: 'DV', value: String(dv), inline: true }] : []),
            )
            .setFooter({ text: 'NIGHT CITY // DM' }).setTimestamp();
          await msg.reply({ embeds: [embed] });
          break;
        }

        // !char [name] — show character sheet
        case 'char': {
          const name = args.slice(1).join(' ').trim();
          if (!name) {
            const list = Object.keys(session.characters);
            if (!list.length) { await msg.reply('当前 Session 无角色数据。'); break; }
            await msg.reply(`当前角色: ${list.map(n => `**${n}**`).join(', ')}`);
            break;
          }
          const char = session.characters[name];
          if (!char) { await msg.reply(`找不到角色: **${name}**`); break; }
          const embed = new EmbedBuilder()
            .setTitle(`📋 ${char.handle}`)
            .setColor(0xffcc00)
            .setDescription(buildCharacterText(char))
            .setFooter({ text: 'NIGHT CITY // CHARACTER' }).setTimestamp();
          await msg.reply({ embeds: [embed] });
          break;
        }

        // !session — show current session info
        case 'session': case 's': {
          if (!sessionActive()) { await msg.reply('当前无活跃 Session。'); break; }
          const dur = Math.round((Date.now() - session.startedAt) / 60000);
          const embed = new EmbedBuilder()
            .setTitle(`📅 ${session.name}`)
            .setColor(0xffcc00)
            .addFields(
              { name: '时长',   value: `${dur} 分钟`,               inline: true },
              { name: '投掷数', value: String(session.rolls.length), inline: true },
              { name: '角色数', value: String(Object.keys(session.characters).length), inline: true },
            )
            .setFooter({ text: 'NIGHT CITY // SESSION' }).setTimestamp();
          await msg.reply({ embeds: [embed] });
          break;
        }

        // !log [n] — show last n rolls (default 10)
        case 'log': {
          const n    = Math.min(parseInt(args[1] ?? '10', 10) || 10, 20);
          const last = session.rolls.slice(-n);
          if (!last.length) { await msg.reply('Session 无投掷记录。'); break; }
          const lines = last.map(r => {
            const icon = r.critical ? '⚡' : r.fumble ? '☠' : r.success === true ? '✅' : r.success === false ? '❌' : '🎲';
            return `${icon} **${r.player ?? '?'}** ${r.label ?? ''} → **${r.total}**`;
          });
          await msg.reply(lines.join('\n'));
          break;
        }

        // !help
        case 'help': case 'h': {
          await msg.reply([
            '**NETRUNNER DICE — DM 指令**',
            '`!roll <骰子>`    普通投骰，如 `!roll 3d6+2`',
            '`!check <STAT> <技能> [DV]`    技能检定（爆炸骰），如 `!check 6 4 13`',
            '`!char [角色名]`  查看角色卡',
            '`!session`        Session 信息',
            '`!log [n]`        最近 n 次投掷记录',
            '`!help`           显示本帮助',
          ].join('\n'));
          break;
        }

        default:
          await msg.reply(`未知指令 \`!${cmd}\`，输入 \`!help\` 查看指令列表。`);
      }
    } catch (e) {
      console.error('[bot] error handling command:', e);
      await msg.reply('处理指令时出错: ' + e.message).catch(() => {});
    }
  });

  client.login(BOT_TOKEN).catch(e => {
    console.error('[bot] Login failed:', e.message);
    console.error('[bot] Please check DISCORD_BOT_TOKEN in .env');
  });
}

// ── Helper ──────────────────────────────────────────────────────────────────

function buildCharacterText(char) {
  const s = char.stats ?? {};
  const hp = 10 + 5 * Math.floor(((s.BODY ?? 4) + (s.WILL ?? 4)) / 2);
  const statLine = ['INT','REF','DEX','TECH','COOL','WILL','LUCK','MOVE','BODY','EMP']
    .map(k => `${k} **${s[k] ?? '?'}**`).join(' · ');
  return `${statLine}\nHP **${hp}** · 人性值 **${(s.EMP ?? 4) * 10}**`;
}

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  NIGHT CITY DICE SERVER  //  赛博朋克红      ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  URL:     http://localhost:${PORT}`);
  console.log(`  骰子器:  http://localhost:${PORT}/dice-roller.html`);
  console.log(`  Webhook: ${WEBHOOK_URL ? '✓ 已配置' : '✗ 未配置 (设置 DISCORD_WEBHOOK_URL)'}`);
  console.log(`  Bot:     ${BOT_TOKEN    ? '✓ 已配置' : '✗ 未配置 (设置 DISCORD_BOT_TOKEN)'}`);
  if (!WEBHOOK_URL && !BOT_TOKEN) {
    console.log('');
    console.log('  提示: 复制 .env.example 为 .env 并填写 Discord 配置');
  }
  console.log('');
});
