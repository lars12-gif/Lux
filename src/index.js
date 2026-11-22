
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@itsliaaa/baileys';

import { getDB, saveDB } from './storage.js';
import { getForm, RANKS, POINT_RULES } from './forms.js';
import { createLuxGroups } from './groups.js';

// ==========================================
// LUX BOT CONFIGURATION
// ==========================================

const PREFIX = process.env.PREFIX || '!lux';
const OWNER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const AUTH_DIR = path.resolve('auth');

const db = getDB();

let sock = null;
let reconnecting = false;
let socketGeneration = 0;

const log = (...args) => {
  console.log(new Date().toISOString(), ...args);
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const jidFromNumber = number =>
  `${String(number).replace(/\D/g, '')}@s.whatsapp.net`;

const senderNumber = jid =>
  (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

const isOwner = jid => senderNumber(jid) === OWNER;

const isAdmin = jid => {
  const admins = (process.env.ADMIN_NUMBERS || '')
    .split(',')
    .map(number => number.trim().replace(/\D/g, ''))
    .filter(Boolean);

  return isOwner(jid) || admins.includes(senderNumber(jid));
};

// ==========================================
// MESSAGE HELPERS
// ==========================================

function getText(message) {
  const m = message?.message || {};

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ''
  );
}

async function send(jid, text) {
  if (!jid) {
    throw new Error('وجهة الإرسال غير محددة.');
  }

  if (!sock) {
    throw new Error('البوت غير متصل حالياً.');
  }

  return sock.sendMessage(jid, { text });
}

// ==========================================
// FORMS CHANNEL
// ==========================================

async function createFormsChannel() {
  if (db.channelJid) {
    log('[CHANNEL] القناة محفوظة مسبقاً:', db.channelJid);
    return db.channelJid;
  }

  if (typeof sock.newsletterCreate !== 'function') {
    throw new Error(
      'هذه النسخة لا توفر newsletterCreate. أنشئ القناة يدوياً ثم اربطها بأمر !lux set-channel.'
    );
  }

  const name = process.env.FORMS_CHANNEL_NAME || 'LUX | FORMS';

  const description =
    process.env.FORMS_CHANNEL_DESCRIPTION ||
    'القناة الرسمية لاستمارات وطلبات نقابة LUX.';

  const result = await sock.newsletterCreate(name, description);

  const jid =
    result?.id ||
    result?.jid ||
    result?.newsletterJid;

  if (!jid) {
    throw new Error(
      'طلب إنشاء القناة لم يرجع معرّفاً. تحقق من واتساب قبل إعادة المحاولة.'
    );
  }

  db.channelJid = jid;
  db.channelCreatedAt = new Date().toISOString();

  saveDB();

  log('[CHANNEL] تم تسجيل قناة الاستمارات:', jid);

  return jid;
}

async function postForm(key, customText = '') {
  const body = customText || getForm(key);

  if (!body) {
    throw new Error('اسم الاستمارة غير معروف. استخدم !lux forms.');
  }

  if (!db.channelJid) {
    throw new Error(
      'قناة الاستمارات غير مربوطة. استخدم !lux create-channel أو !lux set-channel.'
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

// ==========================================
// HELP COMMAND
// ==========================================

function helpText() {
  return `♛ LUX BOT | لوحة الأوامر ♛

الأوامر الإدارية (للمؤسس/الإدارة):

${PREFIX} help
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

تنبيه:
الأوامر الإدارية لا تعمل إلا من رقم المؤسس أو الأرقام الموجودة في ADMIN_NUMBERS.`;
}

// ==========================================
// COMMAND HANDLER
// ==========================================

async function handleCommand(msg) {
  const jid = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;

  const text = getText(msg).trim();

  if (!text.toLowerCase().startsWith(PREFIX.toLowerCase())) {
    return;
  }

  const rest = text.slice(PREFIX.length).trim();

  const [commandRaw, ...args] = rest.split(/\s+/);

  const command = (commandRaw || 'help').toLowerCase();

  const argText = rest
    .slice(commandRaw?.length || 0)
    .trim();

  if (command === 'help' || command === 'مساعدة') {
    return send(jid, helpText());
  }

  if (!isAdmin(sender)) {
    return send(jid, 'هذا الأمر للإدارة فقط.');
  }

  try {
    if (command === 'status') {
      const groupCount = Object.keys(db.groups).length;

      return send(
        jid,
        `♛ LUX BOT

الحالة: متصل
قناة الاستمارات: ${db.channelJid || 'غير مربوطة'}
القروبات المسجلة: ${groupCount}
الاستمارات المنشورة: ${db.forms.length}`
      );
    }

    if (command === 'create-channel') {
      const id = await createFormsChannel();

      return send(
        jid,
        `تم إنشاء/تسجيل قناة الاستمارات.\nالمعرّف: ${id}`
      );
    }

    if (command === 'set-channel') {
      if (!jid.endsWith('@newsletter')) {
        return send(
          jid,
          'افتح قناة الاستمارات وأرسل الأمر من داخلها. إذا لم تسمح نسخة واتساب بذلك، أضف المعرّف إلى channelJid في data/lux-data.json.'
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
      const ownerJid =
        sock.user?.id ||
        jidFromNumber(OWNER);

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

الجديدة:
${result.created.join(', ') || 'لا يوجد'}

المسجلة سابقاً:
${result.existing.join(', ') || 'لا يوجد'}`
      );
    }

    if (command === 'forms') {
      return send(
        jid,
        `الاستمارات المتاحة:

welcome — استقبال عضو
work — توثيق ورك
s — فعالية صغيرة
m — فعالية متوسطة
l — فعالية كبيرة
winner — نتائج فعالية
promotion — طلب مراجعة ترقية
announcement — إعلان رسمي
points — سجل نقاط
member — ملف عضو

للنشر:
${PREFIX} post s`
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

      const result = await postForm('custom', argText);

      return send(jid, result);
    }

    if (command === 'ranks') {
      const lines = RANKS.map(rank =>
        `• ${rank.name}: ${
          rank.points ?? rank.note ?? 'حسب قرار المؤسس'
        }${rank.parties ? ` + ${rank.parties} طرف` : ''}`
      );

      return send(
        jid,
        `♛ رتب LUX ♛\n\n${lines.join('\n')}`
      );
    }

    if (command === 'rankrules' || command === 'points') {
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
          `الصيغة:\n${PREFIX} pointcalc <النقاط> <الأطراف>`
        );
      }

      const eligible = RANKS.filter(rank =>
        rank.points !== null &&
        points >= rank.points &&
        (rank.parties === null || parties >= rank.parties)
      );

      return send(
        jid,
        `حسب الأرقام المدخلة، أعلى رتبة مستوفاة حسابياً:

${eligible.at(-1)?.name || 'لم تستوفِ شروط رتبة بعد'}

ملاحظة:
الترقية الفعلية تبقى بقرار الإدارة، وليشر يرقّي من يراه مناسباً.`
      );
    }

    if (command === 'setgroup') {
      const [key, groupJid] = args;

      const allowed = [
        'main',
        'reception',
        'work',
        'admin',
        'announcements'
      ];

      if (
        !allowed.includes(key) ||
        !groupJid?.endsWith('@g.us')
      ) {
        return send(
          jid,
          `الصيغة:\n${PREFIX} setgroup main 123@g.us`
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

  } catch (error) {
    log('[COMMAND ERROR]', error?.stack || error);

    return send(
      jid,
      `تعذر تنفيذ الأمر: ${error?.message || 'خطأ غير معروف'}`
    );
  }
}

// ==========================================
// PAIRING CODE
// ==========================================

async function requestPairingCode(activeSocket, generation, state) {
  if (state.creds.registered) {
    log('[PAIRING] الجهاز مرتبط مسبقاً؛ لن يتم طلب رمز جديد.');
    return;
  }

  if (!OWNER) {
    throw new Error(
      'OWNER_NUMBER غير موجود. أضف رقم المؤسس مع مفتاح الدولة في متغيرات الاستضافة.'
    );
  }

  const phone = OWNER;

  if (phone.length < 8) {
    throw new Error(
      'رقم OWNER_NUMBER غير صحيح. استخدم مفتاح الدولة ثم الرقم، أرقام فقط.'
    );
  }

  await sleep(1500);

  if (
    generation !== socketGeneration ||
    sock !== activeSocket ||
    state.creds.registered
  ) {
    return;
  }

  if (typeof activeSocket.requestPairingCode !== 'function') {
    throw new Error(
      'هذه النسخة لا توفر requestPairingCode().'
    );
  }

  log('[PAIRING] جاري طلب رمز الربط من واتساب...');

  const code = await activeSocket.requestPairingCode(phone);

  if (
    generation !== socketGeneration ||
    sock !== activeSocket ||
    state.creds.registered
  ) {
    return;
  }

  if (!code) {
    throw new Error(
      'لم ترجع المكتبة رمز اقتران.'
    );
  }

  console.log('\n');
  console.log('========================================');
  console.log('          ♛ LUX WHATSAPP BOT ♛');
  console.log('========================================');
  console.log('');
  console.log('رمز ربط الجهاز:');
  console.log('');
  console.log(`          ${code}`);
  console.log('');
  console.log('افتح واتساب من هاتفك:');
  console.log('الأجهزة المرتبطة');
  console.log('ربط جهاز');
  console.log('الربط برقم الهاتف');
  console.log('');
  console.log('========================================');
  console.log('\n');

  log('[PAIRING] تم إصدار الرمز. أدخله في واتساب.');
}

// ==========================================
// START SOCKET
// ==========================================

async function start() {
  if (reconnecting === 'starting') {
    return;
  }

  reconnecting = 'starting';

  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    let version;

    try {
      ({ version } = await fetchLatestBaileysVersion());

      log('[BOT] تم تحديد إصدار واتساب المتاح.');
    } catch (error) {
      log(
        '[BOT] تعذر جلب آخر إصدار، سيستخدم الإصدار الافتراضي:',
        error?.message || error
      );
    }

    const generation = ++socketGeneration;

    const activeSocket = makeWASocket({
      auth: state,
      version,

      printQRInTerminal: false,

      browser: [
        'LUX BOT',
        'Chrome',
        '1.0.0'
      ],

      logger: {
        level: 'silent',
        trace() {},
        debug() {},
        info() {},
        warn: (...args) => log('[WARN]', ...args),
        error: (...args) => log('[ERROR]', ...args),
        fatal: (...args) => log('[FATAL]', ...args),
        child() {
          return this;
        }
      },

      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock = activeSocket;
    reconnecting = false;

    let pairingRequested = false;

    // Save credentials whenever they change.
    activeSocket.ev.on('creds.update', saveCreds);

    // ======================================
    // CONNECTION EVENTS
    // ======================================

    activeSocket.ev.on(
      'connection.update',
      async update => {
        if (
          generation !== socketGeneration ||
          sock !== activeSocket
        ) {
          return;
        }

        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        // Request pairing code only after the QR event.
        if (
          qr &&
          !state.creds.registered &&
          !pairingRequested
        ) {
          pairingRequested = true;

          try {
            await requestPairingCode(
              activeSocket,
              generation,
              state
            );
          } catch (error) {
            log(
              '[PAIRING] فشل طلب رمز الاقتران:',
              error?.stack || error
            );
          }
        }

        if (connection === 'connecting') {
          log('[BOT] جاري الاتصال بواتساب...');
        }

        if (connection === 'open') {
          log(
            '[BOT] تم الاتصال بواتساب بنجاح:',
            activeSocket.user?.id
          );

          if (
            process.env.AUTO_CREATE_FORMS_CHANNEL === 'true' &&
            !db.channelJid
          ) {
            try {
              await createFormsChannel();
            } catch (error) {
              log(
                '[CHANNEL] تعذر إنشاء القناة تلقائياً:',
                error?.message || error
              );
            }
          }
        }

        if (connection !== 'close') {
          return;
        }

        const disconnectError = lastDisconnect?.error;

        const statusCode =
          disconnectError?.output?.statusCode ??
          disconnectError?.statusCode ??
          'unknown';

        log(
          '[BOT] انقطع اتصال واتساب. Status:',
          statusCode
        );

        log(
          '[BOT] تفاصيل الانقطاع:',
          disconnectError?.message || disconnectError
        );

        if (sock === activeSocket) {
          sock = null;
        }

        if (statusCode === DisconnectReason.loggedOut) {
          log(
            '[BOT] تم تسجيل الخروج. احتفظ بمجلد auth؛ لا تحذفه إلا إذا أردت إعادة الربط من الصفر.'
          );

          return;
        }

        if (reconnecting) {
          return;
        }

        reconnecting = true;

        const delay =
          statusCode === DisconnectReason.restartRequired
            ? 1200
            : 5000;

        log(
          `[BOT] إعادة محاولة الاتصال بعد ${delay / 1000} ثوانٍ...`
        );

        setTimeout(() => {
          reconnecting = false;

          start().catch(error => {
            log(
              '[BOT] فشلت إعادة الاتصال:',
              error?.stack || error
            );
          });
        }, delay);
      }
    );

    // ======================================
    // INCOMING MESSAGES
    // ======================================

    activeSocket.ev.on(
      'messages.upsert',
      async ({ messages, type }) => {
        if (type !== 'notify') {
          return;
        }

        for (const msg of messages || []) {
          if (!msg.message || msg.key.fromMe) {
            continue;
          }

          try {
            await handleCommand(msg);
          } catch (error) {
            log(
              '[MESSAGE ERROR]',
              error?.stack || error
            );
          }
        }
      }
    );

    log('[BOT] تم تشغيل Socket بنجاح.');

    if (state.creds.registered) {
      log('[PAIRING] الحساب مرتبط مسبقاً.');
    } else {
      log('[PAIRING] بانتظار حدث QR لطلب رمز الاقتران.');
    }

  } catch (error) {
    reconnecting = false;

    log(
      '[BOT] خطأ أثناء بدء التشغيل:',
      error?.stack || error
    );

    throw error;
  }
}

// ==========================================
// PROCESS ERROR HANDLERS
// ==========================================

process.on('uncaughtException', error => {
  log(
    '[FATAL]',
    error?.stack || error
  );
});

process.on('unhandledRejection', error => {
  log(
    '[UNHANDLED REJECTION]',
    error?.stack || error
  );
});

// ==========================================
// BOOT
// ==========================================

start().catch(error => {
  log(
    '[STARTUP ERROR]',
    error?.stack || error
  );

  process.exit(1);
});
