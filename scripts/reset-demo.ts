import 'dotenv/config';
import { createDatabase } from '../server/db.js';
import { resetDemoCenter } from '../server/demo-reset.js';

const args=process.argv.slice(2);
const values=new Map<string,string>();
for(let i=0;i<args.length;i+=2) {
  if(!['--center','--admin-email'].includes(args[i])||!args[i+1]||values.has(args[i])) {
    throw new Error('Usage: npx tsx scripts/reset-demo.ts --center <center-id> --admin-email <existing-owner-email>');
  }
  values.set(args[i],args[i+1]);
}
const centerId=values.get('--center'),adminEmail=values.get('--admin-email');
if(!centerId||!adminEmail) throw new Error('An explicit --center and --admin-email are required. No data was changed.');

const db=await createDatabase();
try {
  const result=await resetDemoCenter(db,{centerId,adminEmail});
  console.log(JSON.stringify(result,null,2));
} finally {
  await db.close();
}
