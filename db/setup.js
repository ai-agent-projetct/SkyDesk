// Creates the database + tables and the first super admin. `npm run setup -- --demo` also loads sample data.
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const L = require('../src/lib');
const T = require('../src/training');

(async () => {
  const db = process.env.DB_NAME || 'rpto_portal';
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: +process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', multipleStatements: true,
  });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${db}\``);
  await conn.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  await conn.end();
  fs.mkdirSync(L.UPLOAD_DIR, { recursive: true });

  const email = (process.env.SUPER_ADMIN_EMAIL || 'superadmin@example.com').toLowerCase();
  if (!(await L.one('SELECT id FROM users WHERE email=?', [email]))) {
    await L.q("INSERT INTO users (name,email,password_hash,role) VALUES ('Super Admin',?,?,'super_admin')",
      [email, L.hashPassword(process.env.SUPER_ADMIN_PASSWORD || 'ChangeMe@123')]);
    console.log(`Super admin created: ${email}`);
  }
  // Platform defaults: RPTOs use these until they customise their own syllabus / upload their own bank.
  if (!(await L.one('SELECT id FROM syllabus_items WHERE rpto_id IS NULL LIMIT 1')))
    await L.q('INSERT INTO syllabus_items (rpto_id,code,section,title,minutes,needs_log,sort) VALUES ?',
      [T.DEFAULT_SYLLABUS.map(s => [null, s.code, s.section, s.title, s.minutes, s.needs_log, s.sort])]);
  if (!(await L.one('SELECT id FROM questions WHERE rpto_id IS NULL LIMIT 1')))
    await L.q('INSERT INTO questions (rpto_id,subject,question,a,b,c,d,correct) VALUES ?', [STARTER_QUESTIONS.map(q => [null, ...q])]);
  if (process.argv.includes('--demo')) await demo();
  console.log('Database ready.');
  await L.pool.end();
})().catch(e => { console.error(e); process.exit(1); });

// Starter platform question bank (super admin can replace it under Question bank).
const STARTER_QUESTIONS = [
  ['Drone Rules', 'In which airspace zone can drones be flown without prior permission?', 'Red zone', 'Yellow zone', 'Green zone', 'Any zone', 'c'],
  ['Drone Rules', 'What is the minimum age to obtain a remote pilot certificate?', '16 years', '18 years', '21 years', '25 years', 'b'],
  ['Drone Rules', 'Which online platform is used for drone registrations and permissions in India?', 'DigitalSky', 'e-Sanchit', 'Parivahan', 'UMANG', 'a'],
  ['Principles of flight', 'Which force opposes the forward motion of an aircraft?', 'Lift', 'Thrust', 'Weight', 'Drag', 'd'],
  ['Principles of flight', 'A multirotor yaws by…', 'Tilting the whole frame', 'Changing relative speed of CW and CCW motors', 'Moving the payload', 'Deploying flaps', 'b'],
  ['Meteorology', 'Which cloud type is most associated with thunderstorms?', 'Cirrus', 'Stratus', 'Cumulonimbus', 'Altostratus', 'c'],
  ['Meteorology', 'As altitude increases, air density generally…', 'Increases', 'Decreases', 'Stays the same', 'Doubles', 'b'],
  ['Maintenance', 'A LiPo battery that is visibly swollen should be…', 'Charged slowly', 'Used for short flights only', 'Removed from service and disposed of safely', 'Stored fully charged', 'c'],
  ['Operations', 'VLOS stands for…', 'Very Low Operating Speed', 'Visual Line of Sight', 'Vertical Lift Operating System', 'Variable Load Output Setting', 'b'],
  ['Operations', 'Before every flight the pilot must first…', 'Take off immediately', 'Complete the pre-flight checklist', 'Call ATC', 'Update firmware', 'b'],
];

// Fictional sample data so every screen has something to show.
async function demo() {
  if (await L.one("SELECT id FROM rptos WHERE name='Demo Drone Academy'")) return console.log('Demo data already present.');
  const pw = L.hashPassword('Demo@1234');
  const user = async (name, email, role, rptoId = null) =>
    (await L.q('INSERT INTO users (rpto_id,name,email,password_hash,role,phone) VALUES (?,?,?,?,?,?)', [rptoId, name, email, pw, role, '9000000000'])).insertId;

  const rid = (await L.q(`INSERT INTO rptos (name,city,address,auth_no,file_no,accountable_manager,contact_email,status,approved_at,about_locked,roll_code,cert_prefix,tagline)
    VALUES ('Demo Drone Academy','Chennai','12 Example Road, Chennai','DEMO/01/2025','DEMO-FILE-001','Asha Menon','admin@demo.test','approved',NOW(),1,'DDA','DDA-C','Learn to fly the right way')`)).insertId;
  await T.addCredits(rid, 5, 'grant', { note: 'Demo starter credits' });
  const am = await user('Asha Menon', 'admin@demo.test', 'member', rid);
  const ins = await user('Ravi Kumar', 'instructor@demo.test', 'member', rid);
  const bd = await user('Meera Iyer', 'sales@demo.test', 'member', rid);
  await L.q('INSERT INTO members (rpto_id,user_id,role,dgca_cert) VALUES ?', [[
    [rid, am, 'Accountable Manager', null], [rid, am, 'Instructor', 'demo-cert.pdf'], [rid, ins, 'Instructor', 'demo-cert.pdf'], [rid, bd, 'Business Development', null]]]);
  await L.q('UPDATE rptos SET default_trainer_id=? WHERE id=?', [ins, rid]);

  const asset = (type, name, extra = {}) => L.q('INSERT INTO assets SET ?', [{ rpto_id: rid, type, name, ...extra }]).then(r => r.insertId);
  const rp1 = await asset('rpas', 'Trainer X4', { make: 'Example Aero', category: 'Rotorcraft', rpas_class: 'Small', type_certified: 1, uin: 'UA-DEMO-0001' });
  const rp2 = await asset('rpas', 'Trainer X6', { make: 'Example Aero', category: 'Rotorcraft', rpas_class: 'Small', type_certified: 1, uin: 'UA-DEMO-0002' });
  const bats = [];
  for (let i = 1; i <= 4; i++) bats.push(await asset('battery', 'LiPo 6S', { make: 'Example Cells', serial_no: `BAT-00${i}`, capacity_mah: 16000, voltage: 22.2 }));
  const ch = await asset('charger', 'Dual charger', { make: 'Example Power' });
  const sim = await asset('simulator', 'Desktop simulator', { make: 'Example Sim' });
  const cls = await asset('classroom', 'Classroom 1', { capacity_seats: 20 });
  const fld = await asset('field', 'Training field A', { notes: 'Green zone, 2 km from office' });

  const bid = (await L.q(`INSERT INTO batches (rpto_id,title,certificate,rpas_category,rpas_class,batch_no,delivery,start_date,seats,fee,status)
    VALUES (?,?,?,?,?,?,?,CURDATE(),?,?,'active')`, [rid, 'Small Rotorcraft — Batch 01', 'Cat-1 [VLOS]', 'Rotorcraft', 'Small', '01', 'onsite', 6, 35000])).insertId;
  await L.q('INSERT INTO batch_resources (batch_id,kind,ref_id) VALUES ?', [[[bid, 'instructor', am], [bid, 'instructor', ins],
    ...[rp1, rp2, ...bats, ch, sim, cls, fld].map(a => [bid, 'asset', a])]]);

  const rpto = await L.one('SELECT * FROM rptos WHERE id=?', [rid]), batch = await L.one('SELECT * FROM batches WHERE id=?', [bid]);
  for (const [name, email] of [['Karthik Raj', 'student1@demo.test'], ['Divya Nair', 'student2@demo.test']]) {
    const sid = await user(name, email, 'student');
    await L.q("UPDATE users SET dob='2000-05-15', father_name='Parent Name', address='Chennai', doc_consent_at=NOW() WHERE id=?", [sid]);
    await L.q('INSERT INTO trainee_documents (user_id,doc_type,file,original_name,status) VALUES ?',
      [Object.keys(L.TRAINEE_DOCS).map(k => [sid, k, `demo-${k}.pdf`, `${k}.pdf`, 'verified'])]);
    await L.q("INSERT INTO applications (rpto_id,batch_id,user_id,status,roll_no,decided_at) VALUES (?,?,?,'accepted',?,NOW())", [rid, bid, sid, await T.nextRollNo(rpto, batch)]);
    const fee = (await L.q('INSERT INTO fees (rpto_id,user_id,batch_id,amount,paid,due_date) VALUES (?,?,?,35000,15000,CURDATE() + INTERVAL 7 DAY)', [rid, sid, bid])).insertId;
    await L.q("INSERT INTO fee_payments (fee_id,rpto_id,amount,mode,paid_on,receipt_no) VALUES (?,?,15000,'upi',CURDATE(),?)",
      [fee, rid, `RCPT/${new Date().getFullYear()}/${String(await L.nextSeq('rptos', rid, 'receipt_seq')).padStart(5, '0')}`]);
  }
  const s3 = await user('Pending Applicant', 'student3@demo.test', 'student');
  await L.q('INSERT INTO applications (rpto_id,batch_id,user_id) VALUES (?,?,?)', [rid, bid, s3]);
  await T.autoSchedule(bid);
  await L.q("UPDATE tests SET question_count=10, open=1 WHERE batch_id=? AND type='theory'", [bid]);
  await L.q("INSERT INTO leads (rpto_id,name,phone,city,source,interest,follow_up,status) VALUES ?", [[
    [rid, 'Sample Lead One', '9000000001', 'Chennai', 'Instagram', 'Small rotorcraft course', L.today(), 'new'],
    [rid, 'Sample Lead Two', '9000000002', 'Madurai', 'Referral', 'Agri spraying course', null, 'contacted']]]);
  await L.q('INSERT INTO rptos (name,city,contact_email,status) VALUES (?,?,?,?)', ['Sample Pending RPTO', 'Pune', 'pending@demo.test', 'pending']);
  await L.q("INSERT INTO maintenance (rpto_id,asset_id,date,type,description,done_by,next_due) VALUES (?,?,CURDATE(),'inspection','Pre-batch inspection, props replaced','Ravi Kumar',CURDATE() + INTERVAL 20 DAY)", [rid, rp1]);

  // A synthetic practice flight for student1 (take-off, 20 m square at 15 m, land) so the 3D replay has data.
  const s1 = (await L.one("SELECT id FROM users WHERE email='student1@demo.test'")).id;
  const pts = [], lat0 = 13.0827, lon0 = 80.2707, m2lat = 1 / 110540, m2lon = 1 / (111320 * Math.cos(lat0 * Math.PI / 180));
  const legs = [[0, 0, 0], [0, 0, 15], [20, 0, 15], [20, 20, 15], [0, 20, 15], [0, 0, 15], [0, 0, 0]];
  let t = 0;
  for (let i = 1; i < legs.length; i++) for (let k = 0; k < 20; k++, t += 1.5) {
    const [x0, y0, z0] = legs[i - 1], [x1, y1, z1] = legs[i], f = k / 20;
    pts.push(`${t},${(lat0 + (y0 + (y1 - y0) * f) * m2lat).toFixed(7)},${(lon0 + (x0 + (x1 - x0) * f) * m2lon).toFixed(7)},${(z0 + (z1 - z0) * f).toFixed(1)},${(25.1 - t / 200).toFixed(2)},14`);
  }
  const track = require('../src/flightlog').parse(Buffer.from('time_s,lat,lon,rel_alt,voltage,sats\n' + pts.join('\n')));
  await L.q(`INSERT INTO tracks (user_id,uploaded_by,file,original_name,format,started_at,duration_s,distance_m,max_alt_m,max_speed,bat_unit,points,notes)
    VALUES (?,?,?,?,?,NOW(),?,?,?,?,?,?,?)`, [s1, s1, 'demo-track.csv', 'demo-practice.csv', track.format, track.duration_s, track.distance_m, track.max_alt_m, track.max_speed, track.bat_unit, JSON.stringify(track.points), 'Sample practice flight']);
  await L.q('INSERT INTO tutorials (category,title,description,status,sort) VALUES ?', [[
    ['Getting started', 'Your pilot hub in five minutes', 'A tour of the dashboard: totals, what needs attention, personal bests and quick actions.', 'live', 1],
    ['Logbooks', 'Upload a flight log and add it to your logbook', 'Upload a .bin, .ulg or .csv file, check the 3D replay, then use "Add to logbook" to record the drone, battery and exercise.', 'live', 1],
    ['Logbooks', 'Tracking battery cycles', 'Add each pack under My fleet with the cycles it had before you started logging and when you plan to retire it.', 'live', 2],
    ['Simulator', 'Practising the circuit and figure-8', 'Step-by-step practice drills in the built-in simulator.', 'soon', 1]]]);
  await L.log(rid, 'Demo data loaded');
  console.log('Demo logins (password Demo@1234): admin@demo.test, instructor@demo.test, sales@demo.test, student1@demo.test, student3@demo.test');
}
