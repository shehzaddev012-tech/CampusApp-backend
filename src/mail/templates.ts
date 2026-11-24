import type { Mail } from './mailer.js';

export type OtpPurpose = 'signup' | 'login' | 'reset';

export const OTP_MINUTES = 10;

const INK = '#14231D';
const GREEN = '#C6F26B';
const PAPER = '#F7F6F0';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Layout {
  preheader: string;
  heading: string;
  intro: string;
  /** A short, prominent value (the code). */
  highlight?: string;
  outro: string;
  footnote: string;
}

/** One branded, mobile-friendly layout (table based, inline styles) for every email we send. */
function layout(l: Layout): string {
  const code = l.highlight
    ? `<tr><td align="center" style="padding:8px 0 24px">
         <div style="display:inline-block;background:${PAPER};border:1px solid #E3E1D6;border-radius:16px;padding:18px 28px;
              font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:34px;line-height:1;font-weight:700;
              letter-spacing:10px;color:${INK}">${esc(l.highlight)}</div>
       </td></tr>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(l.heading)}</title></head>
<body style="margin:0;padding:0;background:#EFEEE6;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(l.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EFEEE6"><tr><td align="center" style="padding:28px 14px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:24px;overflow:hidden">
    <tr><td style="background:${INK};padding:26px 32px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="background:${GREEN};width:36px;height:36px;border-radius:10px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:800;color:${INK}">C</td>
        <td style="padding-left:12px;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:700;color:#FFFFFF;letter-spacing:-0.3px">campushub</td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:34px 32px 8px;font-family:Arial,Helvetica,sans-serif">
      <h1 style="margin:0 0 12px;font-size:26px;line-height:1.2;color:${INK};letter-spacing:-0.5px">${esc(l.heading)}</h1>
      <p style="margin:0 0 22px;font-size:16px;line-height:1.55;color:#4B5A53">${l.intro}</p>
    </td></tr>
    <tr><td style="padding:0 32px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${code}</table></td></tr>
    <tr><td style="padding:0 32px 30px;font-family:Arial,Helvetica,sans-serif">
      <p style="margin:0;font-size:15px;line-height:1.55;color:#4B5A53">${l.outro}</p>
    </td></tr>
    <tr><td style="padding:20px 32px 28px;border-top:1px solid #ECEBE3;font-family:Arial,Helvetica,sans-serif">
      <p style="margin:0;font-size:12.5px;line-height:1.55;color:#7A8680">${l.footnote}</p>
    </td></tr>
  </table>
  <p style="margin:18px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#8A948E">CampusHub &middot; your campus, in one app</p>
</td></tr></table>
</body></html>`;
}

const SAFETY = `Never share this code with anyone. CampusHub staff will never ask for it. If you did not ask for it, you can safely ignore this email.`;

const COPY: Record<OtpPurpose, { subject: string; heading: string; intro: (name: string) => string; preheader: string }> = {
  signup: {
    subject: 'Verify your email for CampusHub',
    heading: 'Verify your email',
    intro: n => `Hi ${n}, welcome to CampusHub. Enter this code in the app to finish creating your account.`,
    preheader: 'Your CampusHub verification code',
  },
  login: {
    subject: 'Your CampusHub sign-in code',
    heading: 'Confirm it is you',
    intro: n => `Hi ${n}, someone is signing in to your CampusHub account. Enter this code in the app to continue.`,
    preheader: 'Your CampusHub sign-in code',
  },
  reset: {
    subject: 'Reset your CampusHub password',
    heading: 'Reset your password',
    intro: n => `Hi ${n}, we received a request to reset your CampusHub password. Enter this code in the app, then choose a new password.`,
    preheader: 'Your CampusHub password reset code',
  },
};

export function otpEmail(purpose: OtpPurpose, to: string, name: string, code: string): Mail {
  const c = COPY[purpose];
  const first = (name.trim().split(/\s+/)[0] ?? 'there') || 'there';
  const intro = c.intro(esc(first));
  return {
    to,
    subject: c.subject,
    code,
    html: layout({
      preheader: c.preheader,
      heading: c.heading,
      intro,
      highlight: code,
      outro: `This code expires in <strong>${OTP_MINUTES} minutes</strong> and can be used once.`,
      footnote: SAFETY,
    }),
    text: `${c.heading}\n\n${c.intro(first)}\n\nYour code: ${code}\n\nThis code expires in ${OTP_MINUTES} minutes and can be used once.\n${SAFETY}\n\nCampusHub`,
  };
}

/** Sent instead of a code when someone tries to register with an email that already has an account. */
export function alreadyRegisteredEmail(to: string, name: string): Mail {
  const first = (name.trim().split(/\s+/)[0] ?? 'there') || 'there';
  const body = `Someone tried to create a CampusHub account with this email address, but you already have one.`;
  return {
    to,
    subject: 'You already have a CampusHub account',
    html: layout({
      preheader: 'You already have an account',
      heading: 'You already have an account',
      intro: `Hi ${esc(first)}, ${body} Open the app and sign in, or use <strong>Forgot password</strong> if you cannot remember it.`,
      outro: 'If this was you, there is nothing else to do.',
      footnote: 'If this was not you, you can ignore this email. Your account is safe and nothing was changed.',
    }),
    text: `You already have an account\n\nHi ${first}, ${body} Open the app and sign in, or use "Forgot password" if you cannot remember it.\n\nIf this was not you, ignore this email. Nothing was changed.\n\nCampusHub`,
  };
}

export function passwordChangedEmail(to: string, name: string): Mail {
  const first = (name.trim().split(/\s+/)[0] ?? 'there') || 'there';
  return {
    to,
    subject: 'Your CampusHub password was changed',
    html: layout({
      preheader: 'Your password was changed',
      heading: 'Password changed',
      intro: `Hi ${esc(first)}, the password for your CampusHub account was just changed. You have been signed out on all devices.`,
      outro: 'You can sign in again with your new password.',
      footnote: 'If you did not do this, reset your password right away using <strong>Forgot password</strong> in the app, and contact your university admin.',
    }),
    text: `Password changed\n\nHi ${first}, the password for your CampusHub account was just changed. You have been signed out on all devices.\n\nIf you did not do this, reset your password right away using "Forgot password" in the app.\n\nCampusHub`,
  };
}
