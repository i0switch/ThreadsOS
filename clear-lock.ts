import { db } from './src/db/index.ts';
import { heartbeatStates, llmTaskQueue } from './src/db/schema.ts';
import { eq } from 'drizzle-orm';

// Check heartbeat state
const state = db.select().from(heartbeatStates).all();
console.log('HEARTBEAT STATE:', JSON.stringify(state, null, 2));

// Clear stale lock if any
db.update(heartbeatStates)
  .set({ lockedBy: null, lockedAt: null })
  .where(eq(heartbeatStates.jobName, 'hourly-heartbeat'))
  .run();
console.log('Lock cleared');

// Also clear any processing tasks (stuck from old worker)
const processing = db.select().from(llmTaskQueue).where(eq(llmTaskQueue.status, 'processing')).all();
console.log('Processing tasks (will be reset to pending):', processing.length);
if (processing.length > 0) {
  db.update(llmTaskQueue)
    .set({ status: 'pending', updatedAt: new Date().toISOString() })
    .where(eq(llmTaskQueue.status, 'processing'))
    .run();
}
