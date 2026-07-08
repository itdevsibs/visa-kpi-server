import nodemailer from "nodemailer";

function cleanText(value) {
  return String(value ?? "").trim();
}

function cleanOptional(value) {
  const text = cleanText(value);
  return text || undefined;
}

let cachedTransporter = null;

export function getMailerTransporter() {
  if (cachedTransporter) return cachedTransporter;

  const host = cleanText(process.env.SMTP_HOST);
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
  const user = cleanText(process.env.SMTP_USER);

  const pass = cleanText(process.env.SMTP_PASS).replace(/\s+/g, "");

  if (!host || !user || !pass) {
    throw new Error(
      "SMTP is not configured. Please check SMTP_HOST, SMTP_USER, and SMTP_PASS.",
    );
  }

  cachedTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
  });

  return cachedTransporter;
}

export async function verifyMailerConnection() {
  const transporter = getMailerTransporter();
  return transporter.verify();
}

export async function sendMail({
  to,
  cc,
  bcc,
  replyTo,
  subject,
  text = "",
  html = "",
  attachments = [],
} = {}) {
  const finalTo = cleanText(to);
  const finalSubject = cleanText(subject);

  if (!finalTo) {
    throw new Error("Email recipient is required.");
  }

  if (!finalSubject) {
    throw new Error("Email subject is required.");
  }

  const transporter = getMailerTransporter();

  const safeAttachments = Array.isArray(attachments)
    ? attachments.filter(Boolean).map((attachment) => ({
        ...attachment,
        filename: attachment.filename,
        path: attachment.path,
        cid: attachment.cid,
        contentType: attachment.contentType,
        contentDisposition: attachment.contentDisposition || "inline",
      }))
    : [];

  console.log("[MAILER SEND]", {
    to: finalTo,
    subject: finalSubject,
    attachmentCount: safeAttachments.length,
    attachments: safeAttachments.map((attachment) => ({
      filename: attachment.filename,
      cid: attachment.cid,
      path: attachment.path,
      contentType: attachment.contentType,
      contentDisposition: attachment.contentDisposition,
    })),
  });

  return transporter.sendMail({
    from:
      cleanOptional(process.env.SMTP_FROM) ||
      cleanOptional(process.env.MAIL_FROM) ||
      cleanOptional(process.env.SMTP_USER),
    to: finalTo,
    cc: cleanOptional(cc),
    bcc: cleanOptional(bcc),
    replyTo: cleanOptional(replyTo),
    subject: finalSubject,
    text: text || "",
    html: html || "",
    attachments: safeAttachments,
  });
}

export default sendMail;