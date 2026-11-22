import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from 'baileys';

import { getDB, saveDB } from './storage.js';
import { getForm, RANKS, POINT_RULES } from './forms.js';
import { createLuxGroups } from './groups.js';

// ========================
// LUX BOT CONFIG
// ========================
const PREFIX = (process.env.PREFIX || '!lux').trim();
const OWNER = (process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS || '')
  .split(',')
  .map(value => value.replace(/\D/g, ''))
  .filter(Boolean);

const AUTH_DIR = path.resolve(process.env.AUTH_DIR || 'auth');
const db = getDB();

let sock = null;
let reconnecting = false;
let socketGeneration = 0;

// Prevent duplicate processing when Baileys emits the same message as notify/append.
const processedMessages = new Map();
const PROCESSED_TTL_MS = 5 * 60 * 1000;

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const log = (...args) => console.log(new Date().toISOString(), ...args);

function senderNumber(jid) {
  if (!jid || typeof jid !== 'string') return '';
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

function jidFromNumber(number) {
  return `${String(number).replace(/\D/g, '')}@s.whatsapp.net`;
}

function senderCandidates(msg) {
  const possibleJids = [
    msg?.key?.participant,
    msg?.key?.participantAlt,
    msg?.key?.remoteJid,
    msg?.key?.remoteJidAlt,
    msg?.participant,
    msg?.participantAlt
  ].filter(value => typeof value === 'string' && value.length > 0);

  return [...new Set(possibleJids.map(senderNumber).filter(Boolean))];
}

function isAdminMessage(msg) {
  const allowed = [...new Set([OWNER, ...ADMIN_NUMBERS].filter(Boolean))];
  if (allowed.length === 0) return false;
  return senderCandidates(msg).some(number => allowed.includes(number));
}

function unwrapMessageContent(content) {
  let current = content || {};

  // Unwrap common WhatsApp message containers.
  for (let i = 0; i < 8; i++) {
    const wrapped =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message ||
      current.viewOnceMessageV2Extension?.message ||
      current.documentWithCaptionMessage?.message ||
      current.editedMessage?.message ||
      current.deviceSentMessage?.message ||
      current.groupMentionedMessage?.message;

    if (!wrapped) break;
    current = wrapped;
  }

  return current;
}

function getText(msg) {
  const content = unwrapMessageContent(msg?.message);

  const text =
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.templateButtonReplyMessage?.selectedId ||
    content.listResponseMessage?.singleSelectReply?.selectedRowId ||
    content.listResponseMessage?.title ||
    content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
    '';

  return typeof text === 'string' ? text : '';
}

async function send(jid, text) {
  if (!jid) throw new Error('وجهة الإرسال غير محددة.');
  if (!sock) throw new Error('البوت غير متصل حالياً.');
  return sock.sendMessage(jid, { text: String(text) });
}

// ========================
// LUX FORMS CHANNEL
// ========================
async function createFormsChannel() {
  if (db.channelJid) {
    log('[CHANNEL] قناة الاستمارات محفوظة مسبقاً:', db.channelJid);
    return db.channelJid;
  }

  if (typeof sock?.newsletterCreate !== 'function') {
    throw new Error(
      'هذه النسخة من Baileys لا توفر newsletterCreate. أنشئ القناة يدوياً ثم اربطها بأمر !lux set-channel.'
    );
  }

  const name = process.env.FORMS_CHANNEL_NAME || 'LUX | FORMS';
  const description =
    process.env.FORMS_CHANNEL_DESCRIPTION ||
    'القناة الرسمية لاستمارات وطلبات نقابة LUX.';

  const result = await sock.newsletterCreate(name, description);
  const jid = result?.id || result?.jid || result?.newsletterJid;

  if (!jid) {
    throw new Error(
      'طلب إنشاء القناة لم يرجع معرّفاً. تحقق من واتساب قبل إعادة المحاولة.'
    );
  }

  db.channelJid = jid;
  db.channelCreatedAt = new Date().toISOString();
  saveDB();

  log('[CHANNEL] تم إنشاء قناة الاستمارات:', jid);
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

  db.forms ||= [];
  db.forms.push({
    key,
    postedAt: new Date().toISOString(),
    preview: body.slice(0, 100)
  });

  saveDB();
  return 'تم إرسال الاستمارة إلى قناة LUX | FORMS.';
}

// ========================
// COMMANDS
// ========================
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
${PREFIX} pointcalc <النقاط> <الأطراف>
${PREFIX} setgroup <main|reception|work|admin|announcements> <JID>

ملاحظة: الأوامر الإدارية تعمل فقط من أرقام OWNER_NUMBER و ADMIN_NUMBERS الموجودة في إعدادات الاستضافة.`;
}

async function handleCommand(msg) {
  const chatJid = msg?.key?.remoteJid;
  if (!chatJid) return;

  const messageText = getText(msg).trim();
  const prefix = PREFIX.toLowerCase();

  if (!messageText.toLowerCase().startsWith(prefix)) return;

  const rest = messageText.slice(PREFIX.length).trim();
  const [commandRaw = 'help', ...args] = rest.split(/\s+/);
  const command = commandRaw.toLowerCase();
  const argText = rest.slice(commandRaw.length).trim();

  log(
    '[MSG] أمر وارد:',
    command,
    '| chat:',
    chatJid,
    '| sender candidates:',
    senderCandidates(msg).join(',') || 'unknown',
    '| fromMe:',
    Boolean(msg?.key?.fromMe)
  );

  // These commands are available to everyone for testing.
  if (['help', 'مساعدة', 'الاوامر', 'الأوامر'].includes(command)) {
    return send(chatJid, helpText());
  }

  if (command === 'ping' || command === 'test') {
    return send(chatJid, '♛ LUX BOT يعمل ويستقبل الرسائل بنجاح.');
  }

  if (!isAdminMessage(msg)) {
    return send(
      chatJid,
      'هذا الأمر للإدارة فقط. تحقق من OWNER_NUMBER و ADMIN_NUMBERS في إعدادات الاستضافة.'
    );
  }

  try {
    if (command === 'status') {
      const groupCount = Object.keys(db.groups || {}).length;
      return send(
        chatJid,
        `LUX BOT: متصل\nقناة الاستمارات: ${db.channelJid || 'غير مربوطة'}\nالقروبات المسجلة: ${groupCount}\nالاستمارات المنشورة: ${(db.forms || []).length}`
      );
    }

    if (command === 'create-channel') {
      const id = await createFormsChannel();
      return send(chatJid, `تم إنشاء/تسجيل قناة الاستمارات.\nالمعرّف: ${id}`);
    }

    if (command === 'set-channel') {
      if (!chatJid.endsWith('@newsletter')) {
        return send(
          chatJid,
          'أرسل هذا الأمر من داخل قناة الاستمارات. إذا لم تدعم نسختك ذلك، أضف معرّف القناة يدوياً إلى channelJid في data/lux-data.json.'
        );
      }

      db.channelJid = chatJid;
      saveDB();
      return send(chatJid, 'تم ربط هذه القناة كقناة استمارات LUX.');
    }

    if (command === 'create-groups') {
      const ownerJid = sock?.user?.id || jidFromNumber(OWNER);
      const result = await createLuxGroups(sock, process.env, db, ownerJid, log);
      saveDB();

      return send(
        chatJid,
        `انتهى إنشاء القروبات.\nالجديدة: ${result.created?.join(', ') || 'لا يوجد'}\nالمسجلة سابقاً: ${result.existing?.join(', ') || 'لا يوجد'}`
      );
    }

    if (command === 'forms') {
      return send(
        chatJid,
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
      return send(chatJid, body || 'الاستمارة غير معروفة. استخدم !lux forms.');
    }

    if (command === 'post') {
      return send(chatJid, await postForm(args[0]));
    }

    if (command === 'posttext') {
      if (!argText) return send(chatJid, 'اكتب النص بعد الأمر.');
      return send(chatJid, await postForm('custom', argText));
    }

    if (command === 'ranks') {
      const lines = RANKS.map(rank =>
        `• ${rank.name}: ${rank.points ?? rank.note ?? 'حسب قرار المؤسس'}${rank.parties ? ` + ${rank.parties} طرف` : ''}`
      );
      return send(chatJid, `رتب LUX:\n${lines.join('\n')}`);
    }

    if (command === 'rankrules' || command === 'points') {
      return send(chatJid, POINT_RULES);
    }

    if (command === 'pointcalc') {
      const points = Number(args[0]);
      const parties = Number(args[1]);

      if (!Number.isFinite(points) || !Number.isFinite(parties)) {
        return send(chatJid, `الصيغة: ${PREFIX} pointcalc <النقاط> <الأطراف>`);
      }

      const eligible = RANKS.filter(rank =>
        rank.points !== null &&
        points >= rank.points &&
        (rank.parties === null || parties >= rank.parties)
      );

      return send(
        chatJid,
        `حسب الأرقام المدخلة، أعلى رتبة مستوفاة حسابياً: ${eligible.at(-1)?.name || 'لم تستوفِ شروط رتبة بعد'}.\nملاحظة: الترقية الفعلية تبقى بقرار الإدارة.`
      );
    }

    if (command === 'setgroup') {
      const [key, groupJid] = args;
      const validKeys = ['main', 'reception', 'work', 'admin', 'announcements'];

      if (!validKeys.includes(key) || !groupJid?.endsWith('@g.us')) {
        return send(
          chatJid,
          `الصيغة: ${PREFIX} setgroup main 123@g.us`
        );
      }

      db.groups ||= {};
      db.groups[key] = {
        ...(db.groups[key] || {}),
        jid: groupJid
      };

      saveDB();
      return send(chatJid, `تم حفظ مجموعة ${key}.`);
    }

    return send(chatJid, `أمر غير معروف. اكتب ${PREFIX} help.`);
  } catch (error) {
    log('[CMD] Command error:', error?.stack || error);
    return send(chatJid, `تعذر تنفيذ الأمر: ${error?.message || error}`);
  }
}

// ========================
// PAIRING
// ========================
async function requestPairingCode(activeSocket, generation, state) {
  if (state.creds.registered) {
    log('[PAIRING] الجهاز مرتبط مسبقاً؛ لن يتم طلب رمز جديد.');
    return;
  }

  if (!OWNER) {
    log('[PAIRING] أضف OWNER_NUMBER مع مفتاح الدولة، أرقام فقط.');
    return;
  }

  await new Promise(resolve => setTimeout(resolve, 2500));

  if (
    generation !== socketGeneration ||
    sock !== activeSocket ||
    state.creds.registered
  ) {
    return;
  }

  try {
    if (typeof activeSocket.requestPairingCode !== 'function') {
      throw new Error('Baileys لا يوفّر requestPairingCode في الإصدار المثبّت.');
    }

    log('[PAIRING] جاري طلب رمز الربط...');
    const customCode = (process.env.PAIRING_CODE || '').trim();

    const code = customCode
      ? await activeSocket.requestPairingCode(OWNER, customCode)
      : await activeSocket.requestPairingCode(OWNER);

    console.log('\n================================');
    console.log('LUX WHATSAPP PAIRING CODE:', code);
    console.log('================================\n');
    log('[PAIRING] أدخل الرمز في واتساب > الأجهزة المرتبطة > ربط جهاز برقم الهاتف.');
  } catch (error) {
    log('[PAIRING] فشل طلب رمز الربط:', error?.stack || error?.message || error);
  }
}

// ========================
// CONNECTION + MESSAGE LISTENER
// ========================
async function start() {
  if (reconnecting === 'starting') return;
  reconnecting = 'starting';

  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
      log('[BOT] Baileys version:', version?.join('.'));
    } catch (error) {
      log('[BOT] تعذر جلب آخر إصدار، سيستخدم الإصدار الافتراضي:', error?.message || error);
    }

    const generation = ++socketGeneration;

    const activeSocket = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      printQRInTerminal: false,
      browser: ['LUX BOT', 'Chrome', '1.0.0'],
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async () => ({ conversation: '' })
    });

    sock = activeSocket;
    reconnecting = false;

    activeSocket.ev.on('creds.update', saveCreds);

    activeSocket.ev.on('connection.update', async update => {
      if (generation !== socketGeneration || sock !== activeSocket) return;

      const { connection, lastDisconnect } = update;

      if (connection === 'connecting') {
        log('[BOT] جاري الاتصال بواتساب...');
      }

      if (connection === 'open') {
        log('[BOT] تم الاتصال بواتساب بنجاح كـ', activeSocket.user?.id);

        if (
          process.env.AUTO_CREATE_FORMS_CHANNEL === 'true' &&
          !db.channelJid
        ) {
          try {
            await createFormsChannel();
          } catch (error) {
            log('[CHANNEL] تعذر الإنشاء التلقائي:', error?.stack || error);
          }
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;

        log('[BOT] انقطع الاتصال. Status:', statusCode || 'unknown');

        if (sock === activeSocket) sock = null;

        if (statusCode === DisconnectReason.loggedOut) {
          log('[BOT] تم تسجيل الخروج. احذف مجلد auth فقط إذا تريد إعادة الربط من الصفر.');
          return;
        }

        if (!reconnecting) {
          reconnecting = true;
          const delay =
            statusCode === DisconnectReason.restartRequired ? 1500 : 5000;

          setTimeout(() => {
            reconnecting = false;
            start().catch(error =>
              log('[BOT] Reconnect failed:', error?.stack || error)
            );
          }, delay);
        }
      }
    });

    // IMPORTANT:
    // notify = incoming live messages.
    // append = messages appended by some Baileys versions / sync flows.
    activeSocket.ev.on('messages.upsert', async event => {
      const { messages = [], type } = event || {};

      log('[MSG] messages.upsert received:', type, '| count:', messages.length);

      if (type !== 'notify' && type !== 'append') return;

      for (const msg of messages) {
        try {
          if (!msg?.message || !msg?.key?.remoteJid) continue;

          const messageId = msg.key.id;
          if (messageId) {
            const now = Date.now();
            const previousTime = processedMessages.get(messageId);

            if (previousTime && now - previousTime < PROCESSED_TTL_MS) {
              continue;
            }

            processedMessages.set(messageId, now);

            if (processedMessages.size > 1000) {
              for (const [id, time] of processedMessages) {
                if (now - time > PROCESSED_TTL_MS) processedMessages.delete(id);
              }
              while (processedMessages.size > 1000) {
                const oldestKey = processedMessages.keys().next().value;
                processedMessages.delete(oldestKey);
              }
            }
          }

          const text = getText(msg).trim();
          if (!text) {
            log('[MSG] وصلت رسالة غير نصية:', msg.key.remoteJid);
            continue;
          }

          log(
            '[MSG] وصلت رسالة:',
            text.slice(0, 100),
            '| chat:',
            msg.key.remoteJid,
            '| fromMe:',
            Boolean(msg.key.fromMe)
          );

          if (!text.toLowerCase().startsWith(PREFIX.toLowerCase())) continue;

          await handleCommand(msg);
        } catch (error) {
          log('[MSG] Message handler error:', error?.stack || error);

          const chatJid = msg?.key?.remoteJid;
          if (chatJid) {
            try {
              await send(chatJid, `صار خطأ أثناء معالجة الأمر: ${error?.message || error}`);
            } catch (sendError) {
              log('[MSG] تعذر إرسال رد الخطأ:', sendError?.stack || sendError);
            }
          }
        }
      }
    });

    // Request pairing code once when there is no saved WhatsApp session.
    if (!state.creds.registered) {
      void requestPairingCode(activeSocket, generation, state);
    }
  } catch (error) {
    reconnecting = false;
    log('[BOT] Fatal startup error:', error?.stack || error);
    throw error;
  }
}

start().catch(error => {
  log('[BOT] Fatal startup error:', error?.stack || error);
  process.exit(1);
});
