import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, {
  Browsers,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from 'baileys';
import pino from 'pino';
import { getDB, saveDB } from './storage.js';
import { getForm, RANKS, POINT_RULES } from './forms.js';
import { createLuxGroups } from './groups.js';

const PREFIX = process.env.PREFIX || '!lux';
const OWNER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const PAIRING_CODE = (process.env.PAIRING_CODE || 'LUX2026A').trim();
const AUTH_DIR = path.resolve('auth');
const db = getDB();

let sock;
let reconnecting = false;
let socketGeneration = 0;

// منع تكرار معالجة نفس الرسالة
const processedMessages = new Map();
const PROCESSED_TTL = 5 * 60 * 1000;

const log = (...args) => console.log(new Date().toISOString(), ...args);

const jidFromNumber = n =>
  `${String(n).replace(/\D/g, '')}@s.whatsapp.net`;

const senderNumber = jid =>
  (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

const isOwner = jid => senderNumber(jid) === OWNER;

// استخراج كل احتمالات رقم المرسل، خصوصاً رسائل المجموعات
function senderCandidates(msg) {
  const jids = [
    msg?.key?.participant,
    msg?.key?.participantAlt,
    msg?.key?.remoteJid,
    msg?.key?.remoteJidAlt,
    msg?.participant,
    msg?.participantAlt
  ].filter(Boolean);

  return [...new Set(jids.map(senderNumber).filter(Boolean))];
}

function isAdminMessage(msg) {
  const allowed = [
    OWNER,
    ...(process.env.ADMIN_NUMBERS || '')
      .split(',')
      .map(x => x.trim().replace(/\D/g, ''))
  ].filter(Boolean);

  return senderCandidates(msg).some(number => allowed.includes(number));
}

// فك أغلفة رسائل واتساب
function unwrapMessage(message) {
  let current = message?.message || {};

  for (let i = 0; i < 8; i++) {
    const inner =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message ||
      current.editedMessage?.message;

    if (!inner) break;

    current = inner;
  }

  return current;
}

// استخراج النص من مختلف أنواع الرسائل
function getText(message) {
  const m = unwrapMessage(message);

  const value =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
    '';

  return typeof value === 'string' ? value : '';
}

async function send(jid, text) {
  if (!jid) throw new Error('وجهة الإرسال غير محددة.');
  if (!sock) throw new Error('البوت غير متصل حالياً.');

  return sock.sendMessage(jid, { text: String(text) });
}

// إنشاء قناة الاستمارات
async function createFormsChannel() {
  if (db.channelJid) {
    log('قناة الاستمارات محفوظة مسبقاً:', db.channelJid);
    return db.channelJid;
  }

  if (typeof sock.newsletterCreate !== 'function') {
    throw new Error(
      'هذه النسخة لا توفر newsletterCreate؛ أنشئ القناة يدوياً من واتساب ثم اربطها بأمر !lux set-channel.'
    );
  }

  const name = process.env.FORMS_CHANNEL_NAME || 'LUX | FORMS';

  const desc =
    process.env.FORMS_CHANNEL_DESCRIPTION ||
    'القناة الرسمية لاستمارات وطلبات نقابة LUX.';

  const result = await sock.newsletterCreate(name, desc);

  const jid =
    result?.id ||
    result?.jid ||
    result?.newsletterJid;

  if (!jid) {
    throw new Error(
      'طلب إنشاء القناة لم يرجع معرّفاً. راجع سجل الاستضافة وتحقق من واتساب قبل إعادة المحاولة.'
    );
  }

  db.channelJid = jid;
  db.channelCreatedAt = new Date().toISOString();

  saveDB();

  log('تم إنشاء قناة الاستمارات:', jid);

  return jid;
}

// نشر الاستمارات
async function postForm(key, customText = '') {
  const body = customText || getForm(key);

  if (!body) {
    throw new Error('اسم الاستمارة غير معروف. استخدم !lux forms.');
  }

  if (!db.channelJid) {
    throw new Error(
      'قناة الاستمارات غير مربوطة. استخدم !lux create-channel أو !lux set-channel داخل القناة.'
    );
  }

  await send(db.channelJid, body);

  db.forms.push({
    key,
    postedAt: new Date().toISOString(),
    preview: body.slice(0, 100)
  });

  saveDB();

  return 'تم إرسال الاستمارة إلى قناة LUX | FORMS.';
}

// قائمة الأوامر
function helpText() {
  return `♛ LUX BOT | لوحة الأوامر ♛

الأوامر العامة:
${PREFIX} help
${PREFIX} ping

الأوامر الإدارية (للمؤسس/الإدارة):
${PREFIX} status
${PREFIX} create-channel
${PREFIX} set-channel
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
${PREFIX} post <نوع>
${PREFIX} posttext <نص>
${PREFIX} ranks
${PREFIX} points
${PREFIX} rankrules
${PREFIX} pointcalc <عدد النقاط> <عدد الأطراف>
${PREFIX} setgroup <main|reception|work|admin|announcements> <JID>

تنبيه: الأوامر الحساسة لا تعمل إلا من رقم المؤسس أو رقم إداري موجود في .env.`;
}

// معالجة الأوامر
async function handleCommand(msg) {
  const jid = msg.key.remoteJid;
  const text = getText(msg).trim();

  if (!text.toLowerCase().startsWith(PREFIX.trim().toLowerCase())) {
    return;
  }

  const rest = text.slice(PREFIX.length).trim();

  const [commandRaw, ...args] = rest.split(/\s+/);

  const command = (commandRaw || 'help').toLowerCase();

  const argText = rest.slice(commandRaw?.length || 0).trim();

  log(
    '[MSG] أمر وارد:',
    command,
    '| chat:',
    jid,
    '| sender:',
    senderCandidates(msg).join(','),
    '| fromMe:',
    Boolean(msg.key.fromMe)
  );

  // أوامر عامة
  if (
    command === 'help' ||
    command === 'مساعدة' ||
    command === 'الاوامر' ||
    command === 'الأوامر'
  ) {
    return send(jid, helpText());
  }

  // اختبار استقبال الرسائل والرد
  if (command === 'ping' || command === 'test') {
    return send(
      jid,
      '♛ LUX BOT يعمل ويستقبل الرسائل بنجاح.'
    );
  }

  // فحص صلاحيات الإدارة
  if (!isAdminMessage(msg)) {
    return send(jid, 'هذا الأمر للإدارة فقط.');
  }

  try {
    if (command === 'status') {
      const groupCount = Object.keys(db.groups || {}).length;

      return send(
        jid,
        `LUX BOT: متصل
قناة الاستمارات: ${db.channelJid || 'غير مربوطة'}
القروبات المسجلة: ${groupCount}
الاستمارات المنشورة: ${(db.forms || []).length}`
      );
    }

    if (command === 'create-channel') {
      const id = await createFormsChannel();

      return send(
        jid,
        `تم إنشاء/تسجيل قناة الاستمارات.
المعرّف: ${id}`
      );
    }

    if (command === 'set-channel') {
      if (!jid.endsWith('@newsletter')) {
        return send(
          jid,
          'افتح قناة الاستمارات وأرسل الأمر من داخلها. إذا لم تسمح نسخة واتساب بإرسال الأمر من القناة، أضف المعرّف إلى data/lux-data.json يدوياً في channelJid.'
        );
      }

      db.channelJid = jid;
      saveDB();

      return send(
        jid,
        'تم ربط هذه القناة كقناة استمارات LUX.'
      );
    }

    if (command === 'create-groups') {
      const ownerJid = sock.user?.id || jidFromNumber(OWNER);

      const result = await createLuxGroups(
        sock,
        process.env,
        db,
        ownerJid,
        log
      );

      saveDB();

      return send(
        jid,
        `انتهى إنشاء القروبات.
الجديدة: ${result.created.join(', ') || 'لا يوجد'}
المسجلة سابقاً: ${result.existing.join(', ') || 'لا يوجد'}`
      );
    }

    if (command === 'forms') {
      return send(
        jid,
        `الاستمارات المتاحة:
welcome — استقبال عضو
work — توثيق ورْك
s — فعالية صغيرة
m — فعالية متوسطة
l — فعالية كبيرة
winner — نتائج فعالية
promotion — طلب مراجعة ترقية
announcement — إعلان رسمي
points — سجل نقاط
member — ملف عضو

للنشر: ${PREFIX} post s`
      );
    }

    if (command === 'form') {
      const body = getForm(args[0]);

      return send(
        jid,
        body || 'الاستمارة غير معروفة. استخدم !lux forms.'
      );
    }

    if (command === 'post') {
      const result = await postForm(args[0]);

      return send(jid, result);
    }

    if (command === 'posttext') {
      if (!argText) {
        return send(jid, 'اكتب النص بعد الأمر.');
      }

      return send(
        jid,
        await postForm('custom', argText)
      );
    }

    if (command === 'ranks') {
      const lines = RANKS.map(
        r =>
          `• ${r.name}: ${r.points ?? r.note ?? 'حسب قرار المؤسس'}${r.parties ? ` + ${r.parties} طرف` : ''}`
      );

      return send(
        jid,
        `رتب LUX:\n${lines.join('\n')}`
      );
    }

    if (command === 'rankrules') {
      return send(jid, POINT_RULES);
    }

    if (command === 'points') {
      return send(jid, POINT_RULES);
    }

    if (command === 'pointcalc') {
      const points = Number(args[0]);
      const parties = Number(args[1]);

      if (
        !Number.isFinite(points) ||
        !Number.isFinite(parties)
      ) {
        return send(
          jid,
          'الصيغة: !lux pointcalc <النقاط> <الأطراف>'
        );
      }

      const eligible = RANKS.filter(
        r =>
          r.points !== null &&
          points >= r.points &&
          (r.parties === null || parties >= r.parties)
      );

      return send(
        jid,
        `حسب الأرقام المدخلة، أعلى رتبة مستوفاة حسابياً: ${eligible.at(-1)?.name || 'لم تستوفِ شروط رتبة بعد'}.
ملاحظة: الترقية الفعلية تبقى بقرار الإدارة، وليشر يرقّي من يراه مناسباً.`
      );
    }

    if (command === 'setgroup') {
      const [key, groupJid] = args;

      if (
        ![
          'main',
          'reception',
          'work',
          'admin',
          'announcements'
        ].includes(key) ||
        !groupJid?.endsWith('@g.us')
      ) {
        return send(
          jid,
          'الصيغة: !lux setgroup main 123@g.us'
        );
      }

      db.groups[key] = {
        ...(db.groups[key] || {}),
        jid: groupJid
      };

      saveDB();

      return send(
        jid,
        `تم حفظ مجموعة ${key}.`
      );
    }

    return send(
      jid,
      'أمر غير معروف. اكتب !lux help.'
    );

  } catch (err) {
    log('Command error:', err?.stack || err);

    return send(
      jid,
      `تعذر تنفيذ الأمر: ${err.message}`
    );
  }
}

// ===============================
// الربط: أبقيته كما أرسلته تماماً
// ===============================

async function requestPairingCode(activeSocket, generation, state) {
  if (state.creds.registered) {
    log('[PAIRING] هذا الجهاز مرتبط مسبقاً؛ لن يتم طلب رمز جديد.');
    return;
  }

  if (!OWNER) {
    log('[PAIRING] خطأ: أضف OWNER_NUMBER مع مفتاح الدولة داخل متغيرات الاستضافة.');
    return;
  }

  // MeowSab/Reze style: request the code after the socket emits its initial QR event.
  await new Promise(resolve => setTimeout(resolve, 3000));

  if (
    generation !== socketGeneration ||
    sock !== activeSocket ||
    state.creds.registered
  ) return;

  try {
    if (typeof activeSocket.requestPairingCode !== 'function') {
      throw new Error('مكتبة Baileys الحالية لا توفّر requestPairingCode().');
    }

    if (PAIRING_CODE.length !== 8) {
      throw new Error('PAIRING_CODE يجب أن يكون 8 أحرف بالضبط (حروف/أرقام).');
    }

    log('[PAIRING] جاري طلب رمز الربط المخصص لرقم المؤسس...');

    const code = await activeSocket.requestPairingCode(
      OWNER,
      PAIRING_CODE
    );

    console.log('\n================================');
    console.log('LUX WHATSAPP PAIRING CODE:', code);
    console.log('================================\n');

    log('[PAIRING] أدخل الرمز في واتساب > الأجهزة المرتبطة > ربط جهاز برقم الهاتف.');

  } catch (error) {
    log(
      '[PAIRING] فشل طلب رمز الربط:',
      error?.stack || error?.message || error
    );
  }
}

async function start() {
  if (reconnecting === 'starting') return;

  reconnecting = 'starting';

  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    let version;

    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (error) {
      log(
        '[BOT] تعذر جلب آخر إصدار؛ سيستخدم الإصدار الافتراضي:',
        error?.message || error
      );
    }

    const generation = ++socketGeneration;

    const activeSocket = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock = activeSocket;
    reconnecting = false;

    activeSocket.ev.on('creds.update', saveCreds);

    activeSocket.ev.on(
      'connection.update',
      async update => {
        if (
          generation !== socketGeneration ||
          sock !== activeSocket
        ) return;

        const { connection, lastDisconnect } = update;

        if (connection === 'connecting') {
          log('[BOT] جاري الاتصال بواتساب...');
        }

        if (connection === 'open') {
          log(
            '[BOT] تم الاتصال بواتساب بنجاح كـ',
            activeSocket.user?.id
          );

          if (
            process.env.AUTO_CREATE_FORMS_CHANNEL === 'true' &&
            !db.channelJid
          ) {
            try {
              await createFormsChannel();
            } catch (e) {
              log(
                'تعذر الإنشاء التلقائي للقناة:',
                e.message
              );
            }
          }
        }

        if (connection === 'close') {
          const code =
            lastDisconnect?.error?.output?.statusCode;

          log(
            '[BOT] انقطع اتصال واتساب. Status:',
            code || 'unknown'
          );

          if (sock === activeSocket) {
            sock = null;
          }

          if (code === DisconnectReason.loggedOut) {
            log(
              '[BOT] تم تسجيل الخروج. احتفظ بمجلد auth؛ احذفه فقط إذا تريد إعادة الربط من الصفر.'
            );
            return;
          }

          if (!reconnecting) {
            reconnecting = true;

            const delay =
              code === DisconnectReason.restartRequired
                ? 1200
                : 5000;

            setTimeout(() => {
              reconnecting = false;

              start().catch(err =>
                log('[BOT] Reconnect failed:', err)
              );
            }, delay);
          }
        }
      }
    );

    // ===============================
    // استقبال الرسائل والرد عليها
    // ===============================

    activeSocket.ev.on(
      'messages.upsert',
      async ({ messages = [], type }) => {

        log(
          '[MSG] حدث استقبال:',
          type,
          '| عدد الرسائل:',
          messages.length
        );

        // استقبال الرسائل الجديدة فقط
        if (type !== 'notify') return;

        for (const msg of messages) {
          try {
            if (
              !msg?.message ||
              !msg?.key?.remoteJid
            ) continue;

            const text = getText(msg).trim();

            if (!text) {
              log(
                '[MSG] وصلت رسالة غير نصية:',
                msg.key.remoteJid
              );
              continue;
            }

            log(
              '[MSG] وصلت رسالة:',
              text.slice(0, 100),
              '| المرسل:',
              senderCandidates(msg).join(','),
              '| fromMe:',
              Boolean(msg.key.fromMe)
            );

            // لا يعالج إلا الأوامر التي تبدأ بالبادئة
            if (
              !text.toLowerCase().startsWith(
                PREFIX.trim().toLowerCase()
              )
            ) continue;

            // منع تكرار الرسالة
            const messageId = msg.key.id;

            if (messageId) {
              const now = Date.now();

              // تنظيف الرسائل القديمة
              for (const [id, time] of processedMessages) {
                if (now - time > PROCESSED_TTL) {
                  processedMessages.delete(id);
                }
              }

              if (processedMessages.has(messageId)) {
                continue;
              }

              processedMessages.set(messageId, now);
            }

            await handleCommand(msg);

          } catch (error) {
            log(
              '[MSG] Message handler error:',
              error?.stack || error
            );

            try {
              await send(
                msg.key.remoteJid,
                `صار خطأ أثناء معالجة الأمر: ${error.message || error}`
              );
            } catch (sendError) {
              log(
                '[MSG] تعذر إرسال رد الخطأ:',
                sendError?.message || sendError
              );
            }
          }
        }
      }
    );

    // ===============================
    // الربط عند حدث QR - بدون تغيير
    // ===============================

    let pairingRequested = false;

    activeSocket.ev.on('connection.update', update => {
      if (
        update.qr &&
        !pairingRequested &&
        !state.creds.registered
      ) {
        pairingRequested = true;

        void requestPairingCode(
          activeSocket,
          generation,
          state
        );
      }
    });

  } catch (err) {
    reconnecting = false;

    log(
      '[BOT] Fatal startup error:',
      err?.stack || err
    );

    throw err;
  }
}

start().catch(err => {
  log('Fatal startup error:', err);
  process.exit(1);
});
