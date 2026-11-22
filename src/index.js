import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} from '@itsliaaa/baileys';
import { getDB, saveDB } from './storage.js';
import { getForm, RANKS, POINT_RULES } from './forms.js';
import { createLuxGroups } from './groups.js';

const PREFIX = process.env.PREFIX || '!lux';
const OWNER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || OWNER).replace(/\D/g, '');
const AUTH_DIR = path.resolve('auth');
const db = getDB();
const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });
let sock;
let reconnecting = false;

const log = (...args) => console.log(new Date().toISOString(), ...args);
const jidFromNumber = n => `${String(n).replace(/\D/g, '')}@s.whatsapp.net`;
const senderNumber = jid => (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const isOwner = jid => senderNumber(jid) === OWNER;
const isAdmin = jid => isOwner(jid) || (process.env.ADMIN_NUMBERS || '').split(',').map(x => x.trim().replace(/\D/g, '')).includes(senderNumber(jid));

function getText(message) {
  const m = message?.message || {};
  return m.conversation || m.extendedTextMessage?.text ||
    m.imageMessage?.caption || m.videoMessage?.caption ||
    m.documentMessage?.caption || m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId || '';
}

async function send(jid, text) {
  if (!jid) throw new Error('وجهة الإرسال غير محددة.');
  return sock.sendMessage(jid, { text });
}

async function createFormsChannel() {
  if (db.channelJid) {
    log('قناة الاستمارات محفوظة مسبقاً:', db.channelJid);
    return db.channelJid;
  }
  if (typeof sock.newsletterCreate !== 'function') {
    throw new Error('هذه النسخة لا توفر newsletterCreate؛ أنشئ القناة يدوياً من واتساب ثم اربطها بأمر !lux set-channel.');
  }
  const name = process.env.FORMS_CHANNEL_NAME || 'LUX | FORMS';
  const desc = process.env.FORMS_CHANNEL_DESCRIPTION || 'القناة الرسمية لاستمارات وطلبات نقابة LUX.';
  const result = await sock.newsletterCreate(name, desc);
  const jid = result?.id || result?.jid || result?.newsletterJid;
  if (!jid) throw new Error('طلب إنشاء القناة لم يرجع معرّفاً. راجع سجل الاستضافة وتحقق من واتساب قبل إعادة المحاولة.');
  db.channelJid = jid;
  db.channelCreatedAt = new Date().toISOString();
  saveDB();
  log('تم إنشاء قناة الاستمارات:', jid);
  return jid;
}

async function postForm(key, customText = '') {
  const body = customText || getForm(key);
  if (!body) throw new Error('اسم الاستمارة غير معروف. استخدم !lux forms.');
  if (!db.channelJid) throw new Error('قناة الاستمارات غير مربوطة. استخدم !lux create-channel أو !lux set-channel داخل القناة.');
  await send(db.channelJid, body);
  db.forms.push({ key, postedAt: new Date().toISOString(), preview: body.slice(0, 100) });
  saveDB();
  return 'تم إرسال الاستمارة إلى قناة LUX | FORMS.';
}

function helpText() {
  return `♛ LUX BOT | لوحة الأوامر ♛

الأوامر الإدارية (للمؤسس/الإدارة):
${PREFIX} help
${PREFIX} status
${PREFIX} create-channel
${PREFIX} set-channel   ← أرسل الأمر داخل قناة الاستمارات
${PREFIX} create-groups
${PREFIX} forms
${PREFIX} form welcome
${PREFIX} form work
${PREFIX} form s
${PREFIX} form m
${PREFIX} form l
${PREFIX} form winner
${PREFIX} form promotion
${PREFIX} form announcement
${PREFIX} form points
${PREFIX} form member
${PREFIX} post <نوع>  ← ينشر استمارة بالقناة
${PREFIX} posttext <نص> ← ينشر نصاً مخصصاً بالقناة
${PREFIX} ranks
${PREFIX} points
${PREFIX} setgroup <main|reception|work|admin|announcements> <JID>

الرتب والنقاط:
${PREFIX} rankrules
${PREFIX} pointcalc <عدد النقاط> <عدد الأطراف>

تنبيه: الأوامر الحساسة لا تعمل إلا من رقم المؤسس أو رقم إداري موجود في .env.`;
}

async function handleCommand(msg) {
  const jid = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;
  const text = getText(msg).trim();
  if (!text.toLowerCase().startsWith(PREFIX.toLowerCase())) return;
  const rest = text.slice(PREFIX.length).trim();
  const [commandRaw, ...args] = rest.split(/\s+/);
  const command = (commandRaw || 'help').toLowerCase();
  const argText = rest.slice(commandRaw?.length || 0).trim();

  if (command === 'help' || command === 'مساعدة') return send(jid, helpText());
  if (!isAdmin(sender)) return send(jid, 'هذا الأمر للإدارة فقط.');

  try {
    if (command === 'status') {
      const groupCount = Object.keys(db.groups).length;
      return send(jid, `LUX BOT: متصل\nقناة الاستمارات: ${db.channelJid || 'غير مربوطة'}\nالقروبات المسجلة: ${groupCount}\nالاستمارات المنشورة: ${db.forms.length}`);
    }
    if (command === 'create-channel') {
      const id = await createFormsChannel();
      return send(jid, `تم إنشاء/تسجيل قناة الاستمارات.\nالمعرّف: ${id}`);
    }
    if (command === 'set-channel') {
      if (!jid.endsWith('@newsletter')) return send(jid, 'افتح قناة الاستمارات وأرسل الأمر من داخلها. إذا لم تسمح نسخة واتساب بإرسال الأمر من القناة، أضف المعرّف إلى data/lux-data.json يدوياً في channelJid.');
      db.channelJid = jid; saveDB();
      return send(jid, 'تم ربط هذه القناة كقناة استمارات LUX.');
    }
    if (command === 'create-groups') {
      const ownerJid = sock.user?.id || jidFromNumber(OWNER);
      const result = await createLuxGroups(sock, process.env, db, ownerJid, log);
      saveDB();
      return send(jid, `انتهى إنشاء القروبات.\nالجديدة: ${result.created.join(', ') || 'لا يوجد'}\nالمسجلة سابقاً: ${result.existing.join(', ') || 'لا يوجد'}`);
    }
    if (command === 'forms') {
      return send(jid, `الاستمارات المتاحة:\nwelcome — استقبال عضو\nwork — توثيق ورْك\ns — فعالية صغيرة\nm — فعالية متوسطة\nl — فعالية كبيرة\nwinner — نتائج فعالية\npromotion — طلب مراجعة ترقية\nannouncement — إعلان رسمي\npoints — سجل نقاط\nmember — ملف عضو\n\nللنشر: ${PREFIX} post s`);
    }
    if (command === 'form') {
      const body = getForm(args[0]);
      return send(jid, body || 'الاستمارة غير معروفة. استخدم !lux forms.');
    }
    if (command === 'post') {
      const result = await postForm(args[0]);
      return send(jid, result);
    }
    if (command === 'posttext') {
      if (!argText) return send(jid, 'اكتب النص بعد الأمر.');
      return send(jid, await postForm('custom', argText));
    }
    if (command === 'ranks') {
      const lines = RANKS.map(r => `• ${r.name}: ${r.points ?? r.note ?? 'حسب قرار المؤسس'}${r.parties ? ` + ${r.parties} طرف` : ''}`);
      return send(jid, `رتب LUX:\n${lines.join('\n')}`);
    }
    if (command === 'rankrules') return send(jid, POINT_RULES);
    if (command === 'points') return send(jid, POINT_RULES);
    if (command === 'pointcalc') {
      const points = Number(args[0]), parties = Number(args[1]);
      if (!Number.isFinite(points) || !Number.isFinite(parties)) return send(jid, 'الصيغة: !lux pointcalc <النقاط> <الأطراف>');
      const eligible = RANKS.filter(r => r.points !== null && points >= r.points && (r.parties === null || parties >= r.parties));
      return send(jid, `حسب الأرقام المدخلة، أعلى رتبة مستوفاة حسابياً: ${eligible.at(-1)?.name || 'لم تستوفِ شروط رتبة بعد'}.\nملاحظة: الترقية الفعلية تبقى بقرار الإدارة، وليشر يرقّي من يراه مناسباً.`);
    }
    if (command === 'setgroup') {
      const [key, groupJid] = args;
      if (!['main','reception','work','admin','announcements'].includes(key) || !groupJid?.endsWith('@g.us')) return send(jid, 'الصيغة: !lux setgroup main 123@g.us');
      db.groups[key] = { ...(db.groups[key] || {}), jid: groupJid };
      saveDB();
      return send(jid, `تم حفظ مجموعة ${key}.`);
    }
    return send(jid, 'أمر غير معروف. اكتب !lux help.');
  } catch (err) {
    log('Command error:', err);
    return send(jid, `تعذر تنفيذ الأمر: ${err.message}`);
  }
}

async function start() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch { version = undefined; }
  sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);
  let pendingQr = null;
  let pairingFinished = false;

  const showQrFallback = qr => {
    if (!qr || pairingFinished || sock.__luxPairingCodePrinted) return;
    console.log('رمز الاقتران لم يصدر؛ هذا QR بديل للربط:');
    qrcode.generate(qr, { small: true });
  };

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && !state.creds.registered) {
      pendingQr = qr;
      if (pairingFinished) showQrFallback(pendingQr);
    }
    if (connection === 'open') {
      log('تم الاتصال بواتساب كـ', sock.user?.id);
      if (process.env.AUTO_CREATE_FORMS_CHANNEL === 'true' && !db.channelJid) {
        try { await createFormsChannel(); }
        catch (e) { log('تعذر الإنشاء التلقائي للقناة:', e.message); }
      }
    }
    if (connection === 'close' && !reconnecting) {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      if (!loggedOut) {
        reconnecting = true;
        setTimeout(() => { reconnecting = false; start().catch(log); }, 5000);
      } else {
        log('تم تسجيل الخروج من واتساب. احذف مجلد auth فقط إذا تريد ربط الجهاز من جديد.');
      }
    }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      try { await handleCommand(msg); } catch (e) { log('Message handler error:', e); }
    }
  });

  // نفس آلية البوت القديم: انتظر قليلاً بعد إنشاء الاتصال ثم اطلب رمز الاقتران.
  if (!state.creds.registered && PAIRING_NUMBER) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    try {
      if (typeof sock.requestPairingCode !== 'function') {
        throw new Error('requestPairingCode غير متوفرة في إصدار Baileys المثبت.');
      }
      const code = await sock.requestPairingCode(PAIRING_NUMBER);
      pairingFinished = true;
      sock.__luxPairingCodePrinted = true;
      console.log('\n================================');
      console.log('رمز اقتران LUX BOT:', code);
      console.log('================================');
      console.log('واتساب > الأجهزة المرتبطة > ربط جهاز > الربط برقم الهاتف، ثم أدخل الرمز.\n');
    } catch (e) {
      pairingFinished = true;
      log('تعذر إصدار رمز الاقتران:', e?.message || e);
      if (pendingQr) showQrFallback(pendingQr);
      else log('لم يصل QR أيضاً؛ راجع إصدار Baileys وأخطاء الاتصال أعلاه.');
    }
  }
}

start().catch(err => { log('Fatal startup error:', err); process.exit(1); });
