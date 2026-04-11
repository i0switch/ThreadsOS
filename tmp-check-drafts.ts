import { db } from './src/db/index.ts';
import { threadPostDrafts, threadPostAudits } from './src/db/schema.ts';
import { desc } from 'drizzle-orm';

const drafts = db.select().from(threadPostDrafts).orderBy(desc(threadPostDrafts.createdAt)).all();
console.log('Total drafts:', drafts.length);
for (const x of drafts) {
  console.log('---', x.status, x.id.slice(0,8));
  console.log(x.body?.slice(0,150));
}
const audits = db.select().from(threadPostAudits).all();
console.log('\nTotal audits:', audits.length);
for (const a of audits) {
  console.log(a.verdict, a.draftId.slice(0,8), JSON.parse(a.reasons || '[]').slice(0,2));
}
