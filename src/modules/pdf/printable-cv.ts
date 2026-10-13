import type { CvContent } from '../cvs/cv-content.schema.js';

/**
 * What the PDF template renders: the CV content with empty fields, items and sections removed
 * and links resolved, so the template itself has no decisions to make. Manual edits can leave
 * empty entries behind (the editor adds blank items), and none of them should print.
 */
export interface PrintableCv {
  name: string;
  headline: string;
  contact: ContactItem[];
  summary: string;
  experience: PrintableEntry[];
  education: PrintableEntry[];
  skills: { id: string; name: string; items: string }[];
}

export interface ContactItem {
  text: string;
  /** Clickable target, or null when the value is printed as plain text. */
  href: string | null;
}

/** An experience or education entry: "title — subtitle", dates on the right, then details. */
export interface PrintableEntry {
  id: string;
  title: string;
  subtitle: string;
  dates: string;
  location: string;
  /** Education only (may contain line breaks). */
  details: string;
  bullets: { id: string; text: string }[];
}

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// "github.com/jane", "www.jane.dev": a host name ending in an alphabetic TLD, then optionally a
// port or path.
const BARE_DOMAIN_RE = /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.\p{L}{2,}([:/?#]\S*)?$/u;

/** Link target for a stored URL; null when it should not be clickable. */
export function linkHref(url: string): string | null {
  const value = url.trim();
  const scheme = SCHEME_RE.exec(value)?.[0].toLowerCase();
  if (scheme) return SAFE_SCHEMES.has(scheme) ? value : null;
  if (EMAIL_RE.test(value)) return `mailto:${value}`;
  if (BARE_DOMAIN_RE.test(value)) return `https://${value}`;
  return null;
}

/** A printed CV must show the address itself (paper is not clickable), without the protocol. */
export function linkText(link: { label: string; url: string }): string {
  const url = link.url
    .trim()
    .replace(/^(https?:\/\/|mailto:)/i, '')
    .replace(/\/$/, '');
  return url || link.label.trim();
}

export function dateRange(start: string, end: string): string {
  return [start.trim(), end.trim()].filter(Boolean).join(' – ');
}

function contactItems(contact: CvContent['contact']): ContactItem[] {
  const items: ContactItem[] = [];
  const email = contact.email.trim();
  if (email) items.push({ text: email, href: EMAIL_RE.test(email) ? `mailto:${email}` : null });
  for (const value of [contact.phone, contact.location]) {
    if (value.trim()) items.push({ text: value.trim(), href: null });
  }
  for (const link of contact.links) {
    const text = linkText(link);
    if (text) items.push({ text, href: link.url.trim() ? linkHref(link.url) : null });
  }
  return items;
}

const hasText = (entry: PrintableEntry) =>
  [entry.title, entry.subtitle, entry.dates, entry.location, entry.details].some(Boolean) ||
  entry.bullets.length > 0;

export function toPrintableCv(content: CvContent): PrintableCv {
  const experience = content.experience
    .map((item) => ({
      id: item.id,
      title: item.title.trim(),
      subtitle: item.company.trim(),
      dates: dateRange(item.startDate, item.endDate),
      location: item.location.trim(),
      details: '',
      bullets: item.bullets
        .map((bullet) => ({ id: bullet.id, text: bullet.text.trim() }))
        .filter((bullet) => bullet.text !== ''),
    }))
    .filter(hasText);

  const education = content.education
    .map((item) => ({
      id: item.id,
      title: item.degree.trim(),
      subtitle: item.institution.trim(),
      dates: dateRange(item.startDate, item.endDate),
      location: item.location.trim(),
      details: item.details.trim(),
      bullets: [],
    }))
    .filter(hasText);

  const skills = content.skills
    .map((group) => ({
      id: group.id,
      name: group.name.trim(),
      items: group.items
        .map((skill) => skill.trim())
        .filter(Boolean)
        .join(', '),
    }))
    .filter((group) => group.items !== '');

  return {
    name: content.contact.fullName.trim(),
    headline: content.contact.headline.trim(),
    contact: contactItems(content.contact),
    summary: content.summary.trim(),
    experience,
    education,
    skills,
  };
}
