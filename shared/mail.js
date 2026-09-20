import { LIMITS } from './limits.js';

const EMPTY = { text: '', plain: false };

function mimeType(part) {
  return (part.contentType ?? '').split(';')[0].trim().toLowerCase();
}

function checkPart(part) {
  if ((part.decryptionStatus ?? 'none') !== 'none' || /encrypted|pkcs7-mime/.test(mimeType(part))) {
    throw new Error('Encrypted message: not sent to the model.');
  }
}

// Validates the entire getFull(id, {decrypt: false}) tree, including attachments,
// and returns the attachment filenames.
export function assertNotEncrypted(full) {
  let parts = 0;
  const attachmentNames = [];
  function visit(part, depth, inAttachment = false) {
    if (depth > LIMITS.mimeDepth || ++parts > LIMITS.mimeParts) throw new Error('Message structure is too large.');
    checkPart(part);
    const attachment = inAttachment || isAttachment(part, mimeType(part), depth);
    if (!inAttachment && attachment && part.name) attachmentNames.push(part.name);
    for (const child of part.parts ?? []) visit(child, depth + 1, attachment);
  }
  visit(full, 0);
  return attachmentNames;
}

// Named parts, attached messages and anything not explicitly inline are attachments.
function isAttachment(part, type, depth) {
  if (part.name) return true;
  if (type === 'message/rfc822') return depth > 0;
  const disposition = Object.entries(part.headers ?? {})
    .find(([name]) => name.toLowerCase() === 'content-disposition')?.[1]?.[0];
  return disposition !== undefined && !/^\s*inline\s*(;|$)/i.test(disposition);
}

// Returns the readable body text (plain preferred over HTML) and attachment names.
// Expects getFull(id, {decrypt: false}); encrypted messages are rejected, never decrypted.
// convertHtml supplies Thunderbird's asynchronous messengerUtilities.convertToPlainText.
export async function extractMessage(full, convertHtml) {
  const attachmentNames = assertNotEncrypted(full);
  async function visit(part, depth) {
    const type = mimeType(part);
    if (isAttachment(part, type, depth)) return EMPTY;
    const children = await Promise.all((part.parts ?? []).map(child => visit(child, depth + 1)));
    if (type === 'text/plain') return { text: part.body ?? '', plain: true };
    if (type === 'text/html') return { text: await convertHtml(part.body ?? ''), plain: false };
    const withText = children.filter(child => child.text.trim());
    if (type === 'multipart/alternative') return withText.find(child => child.plain) ?? withText[0] ?? EMPTY;
    return { text: withText.map(child => child.text).join('\n\n'), plain: withText.some(child => child.plain) };
  }
  const { text } = await visit(full, 0);
  if (!text.trim()) throw new Error('No readable text in this message.');
  return { text, attachmentNames };
}
