import { Document, Link, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { Fragment, type ReactNode } from 'react';
import type { ContactItem, PrintableCv, PrintableEntry } from './printable-cv.js';

const COLOR = {
  text: '#1f2328',
  muted: '#59636e',
  accent: '#1d4f7c',
  rule: '#c9d1d9',
} as const;

const styles = StyleSheet.create({
  page: {
    paddingTop: 40,
    paddingBottom: 40,
    paddingHorizontal: 46,
    fontSize: 9.5,
    lineHeight: 1.4,
    color: COLOR.text,
  },
  name: { fontSize: 20, fontWeight: 700, lineHeight: 1.2 },
  headline: { fontSize: 11.5, color: COLOR.accent, marginTop: 2 },
  contact: { fontSize: 9, color: COLOR.muted, marginTop: 6 },
  contactLink: { color: COLOR.muted, textDecoration: 'none' },
  section: { marginTop: 14 },
  sectionTitle: {
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: COLOR.accent,
    borderBottomWidth: 0.75,
    borderBottomColor: COLOR.rule,
    paddingBottom: 2,
    marginBottom: 6,
  },
  entry: { marginBottom: 8 },
  entryHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  entryHeading: { flexShrink: 1, paddingRight: 10 },
  bold: { fontWeight: 700 },
  dates: { color: COLOR.muted, flexShrink: 0, textAlign: 'right' },
  meta: { color: COLOR.muted },
  details: { marginTop: 2 },
  bulletRow: { flexDirection: 'row', marginTop: 2 },
  bulletMark: { width: 10, color: COLOR.muted },
  bulletText: { flex: 1 },
  skillRow: { marginBottom: 2 },
});

/** No page numbers: react-pdf 4.9 crashes on `render`-prop text in documents of ~10+ pages. */
export function CvDocument({
  cv,
  title,
  fontFamily,
}: {
  cv: PrintableCv;
  title: string;
  fontFamily: string;
}) {
  return (
    <Document
      title={title}
      author={cv.name || undefined}
      creator="AI CV Builder"
      producer="AI CV Builder"
    >
      <Page size="A4" style={[styles.page, { fontFamily }]}>
        <Header cv={cv} />
        {cv.summary !== '' && (
          <Section title="Summary">
            <Text>{cv.summary}</Text>
          </Section>
        )}
        {cv.experience.length > 0 && (
          <Section title="Experience">
            {cv.experience.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
          </Section>
        )}
        {cv.education.length > 0 && (
          <Section title="Education">
            {cv.education.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
          </Section>
        )}
        {cv.skills.length > 0 && (
          <Section title="Skills">
            {cv.skills.map((group) => (
              <Text key={group.id} style={styles.skillRow}>
                {group.name !== '' && <Text style={styles.bold}>{group.name}: </Text>}
                {group.items}
              </Text>
            ))}
          </Section>
        )}
      </Page>
    </Document>
  );
}

function Header({ cv }: { cv: PrintableCv }) {
  return (
    <View>
      {cv.name !== '' && <Text style={styles.name}>{cv.name}</Text>}
      {cv.headline !== '' && <Text style={styles.headline}>{cv.headline}</Text>}
      {cv.contact.length > 0 && (
        <Text style={styles.contact}>
          {cv.contact.map((item, index) => (
            <Fragment key={index}>
              {index > 0 && '  ·  '}
              <ContactValue item={item} />
            </Fragment>
          ))}
        </Text>
      )}
    </View>
  );
}

function ContactValue({ item }: { item: ContactItem }) {
  if (!item.href) return <>{item.text}</>;
  return (
    <Link src={item.href} style={styles.contactLink}>
      {item.text}
    </Link>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      {/* Keeps a heading from being stranded at the bottom of a page. */}
      <Text style={styles.sectionTitle} minPresenceAhead={36}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Entry({ entry }: { entry: PrintableEntry }) {
  return (
    <View style={styles.entry}>
      <View wrap={false} minPresenceAhead={24}>
        <View style={styles.entryHeader}>
          <Text style={styles.entryHeading}>
            {entry.title !== '' && <Text style={styles.bold}>{entry.title}</Text>}
            {entry.title !== '' && entry.subtitle !== '' && ' — '}
            {entry.subtitle}
          </Text>
          {entry.dates !== '' && <Text style={styles.dates}>{entry.dates}</Text>}
        </View>
        {entry.location !== '' && <Text style={styles.meta}>{entry.location}</Text>}
      </View>
      {entry.details !== '' && <Text style={styles.details}>{entry.details}</Text>}
      {entry.bullets.map((bullet) => (
        <View key={bullet.id} style={styles.bulletRow} wrap={false}>
          <Text style={styles.bulletMark}>•</Text>
          <Text style={styles.bulletText}>{bullet.text}</Text>
        </View>
      ))}
    </View>
  );
}
