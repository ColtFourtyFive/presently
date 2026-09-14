import { expect, it } from 'vitest';
import { createDatabase } from '../server/db.js';
import { initializeDatabase } from '../server/seed.js';

it('initializes the demo with valid attendance and does not duplicate it on restart', async () => {
  const db = await createDatabase({ url: '', dataDir: 'memory://' });
  try {
    const options = { seed: true, adminEmail: 'demo-test@test.invalid', adminPassword: 'Demo-test-only-credential' };
    await initializeDatabase(db, options);
    const first = await db.query('SELECT COUNT(*) AS count FROM students');
    expect(Number(first.rows[0].count)).toBeGreaterThan(0);
    const invalid = await db.query("SELECT id FROM visits WHERE checked_out_at < checked_in_at OR (status='closed' AND checked_out_at IS NULL)");
    expect(invalid.rows).toHaveLength(0);
    const historical = await db.query("SELECT id FROM attendance_events WHERE occurred_at < NOW()-INTERVAL '2 years'");
    expect(historical.rows.length).toBeGreaterThan(0);
    await initializeDatabase(db, options);
    const second = await db.query('SELECT COUNT(*) AS count FROM students');
    expect(second.rows[0].count).toBe(first.rows[0].count);
  } finally {
    await db.close();
  }
});
