const GROUPS = [
  ['main', 'GROUP_MAIN', '♛ LUX | MAIN GUILD ♛', 'المقر الرئيسي لنقابة LUX. نقاشات وأصدقاء وفعاليات من عوالم الترفيه المختلفة.'],
  ['reception', 'GROUP_RECEPTION', '♛ LUX | RECEPTION ♛', 'استقبال الأعضاء الجدد والتعريف بالنقابة وتوجيههم.'],
  ['work', 'GROUP_WORK', '♛ LUX | WORK ♛', 'سجل الأعمال والاستقبالات والفعاليات والتوثيق الإداري.'],
  ['admin', 'GROUP_ADMIN', '♛ LUX | ADMIN ♛', 'مجموعة الإدارة والمشرفين والقرارات الداخلية.'],
  ['announcements', 'GROUP_ANNOUNCEMENTS', '♛ LUX | ANNOUNCEMENTS ♛', 'الإعلانات الرسمية والمسابقات والفعاليات والترقيات.']
];

export async function createLuxGroups(sock, env, db, ownerJid, logger) {
  if (typeof sock.groupCreate !== 'function') {
    throw new Error('إصدار المكتبة الحالي لا يوفر groupCreate.');
  }
  const created = [];
  const existing = [];
  // The connected WhatsApp account is the creator; pass other participants only.
  const participants = [...new Set((env.ADMIN_NUMBERS || '').split(',').map(x => x.trim()).filter(Boolean).map(n => `${n.replace(/\D/g, '')}@s.whatsapp.net`))];
  if (!participants.length) throw new Error('أضف رقماً واحداً على الأقل في ADMIN_NUMBERS (رقم عضو/إداري غير الرقم المرتبط بالبوت) حتى تتمكن واتساب من إنشاء القروبات.');
  for (const [key, envKey, fallback, description] of GROUPS) {
    if (db.groups[key]?.jid) { existing.push(key); continue; }
    const name = env[envKey] || fallback;
    const result = await sock.groupCreate(name, participants);
    const jid = result?.id || result?.gid || result?.jid;
    if (!jid) throw new Error(`تم طلب إنشاء ${name} لكن المكتبة لم تُرجع معرّف المجموعة.`);
    db.groups[key] = { jid, name, description, createdAt: new Date().toISOString() };
    created.push(key);
    logger(`تم إنشاء المجموعة: ${name} (${jid})`);
    try { await sock.groupUpdateDescription(jid, description); } catch (e) { logger(`تنبيه: تعذر ضبط وصف ${name}: ${e.message}`); }
  }
  return { created, existing };
}
