-- RPTO portal schema (MySQL 8+). Run via `npm run setup`.

CREATE TABLE IF NOT EXISTS rptos (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  city VARCHAR(100),
  address TEXT,
  auth_no VARCHAR(100),            -- DGCA RPTO authorisation number
  file_no VARCHAR(150),
  accountable_manager VARCHAR(150),
  contact_email VARCHAR(190),
  contact_phone VARCHAR(30),
  tagline VARCHAR(255),
  brand_color VARCHAR(20) DEFAULT '#1d6fe8',
  logo VARCHAR(255), signature VARCHAR(255), stamp VARCHAR(255),
  roll_format VARCHAR(100) DEFAULT '{CODE}/{BATCH}/{SEQ}',
  roll_code VARCHAR(20) DEFAULT 'RPTO',
  cert_prefix VARCHAR(20) DEFAULT 'CERT',
  staff_limit INT DEFAULT 30,
  credits INT NOT NULL DEFAULT 0,   -- completion credits balance (see credit_ledger)
  gstin VARCHAR(20),                -- printed on fee receipts
  default_trainer_id INT NULL,      -- fallback RPA trainer signatory on certificates
  cert_seq INT DEFAULT 0, receipt_seq INT DEFAULT 0,   -- atomic counters (see lib.nextSeq)
  status ENUM('pending','approved','rejected','suspended') DEFAULT 'pending',
  status_note VARCHAR(255),
  about_locked TINYINT DEFAULT 0,
  approved_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS rpto_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rpto_id INT NOT NULL,
  doc_type VARCHAR(60) NOT NULL,
  file VARCHAR(255) NOT NULL,
  original_name VARCHAR(255),
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE CASCADE
);

-- role: super_admin | member (RPTO admin/staff, see members) | student
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rpto_id INT NULL,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(190) NOT NULL UNIQUE,
  phone VARCHAR(30),
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('super_admin','member','student') NOT NULL,
  active TINYINT DEFAULT 1,
  dob DATE, gender VARCHAR(20), address TEXT, father_name VARCHAR(150),
  avatar VARCHAR(255),              -- emoji text or uploaded filename
  is_pilot TINYINT DEFAULT 0, license_no VARCHAR(60), license_expiry DATE, regulator VARCHAR(20) DEFAULT 'DGCA',
  pro_until DATE,                   -- pilot paid plan valid until
  session_ver INT DEFAULT 0,        -- bump to sign the user out everywhere
  signature VARCHAR(255),           -- instructor's own signature (RPA trainer on certificates)
  totp_secret VARCHAR(64), totp_enabled TINYINT DEFAULT 0, totp_last BIGINT, recovery_codes JSON,   -- two-factor login (totp_last blocks code re-use)
  doc_consent_at DATETIME,          -- consent to share documents with RPTOs applied to
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash CHAR(64) PRIMARY KEY,
  user_id INT NOT NULL,
  expires_at DATETIME NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,             -- who paid
  rpto_id INT NULL,                 -- set for RPTO completion-credit purchases
  plan VARCHAR(20) NOT NULL,        -- pro_month | pro_year | credits
  quantity INT NULL,                -- credits bought
  amount_paise INT NOT NULL,
  order_id VARCHAR(64) NOT NULL UNIQUE,
  payment_id VARCHAR(64),
  status ENUM('created','paid','failed') DEFAULT 'created',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE SET NULL
);

-- Completion credits: every change to rptos.credits is recorded here (+purchase/+grant, -1 per certificate).
CREATE TABLE IF NOT EXISTS credit_ledger (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rpto_id INT NOT NULL,
  delta INT NOT NULL,
  reason ENUM('purchase','grant','adjust','certificate') NOT NULL,
  application_id INT NULL,
  payment_id INT NULL,
  note VARCHAR(255),
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE CASCADE
);

-- Partner programme: an RPTO's share of Pilot Pro payments by trainees it certified recently.
CREATE TABLE IF NOT EXISTS partner_earnings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rpto_id INT NOT NULL,
  payment_id INT NOT NULL UNIQUE,
  user_id INT NOT NULL,
  amount_paise INT NOT NULL,
  status ENUM('due','paid') DEFAULT 'due',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME,
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE CASCADE,
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE
);

-- One person can hold several roles in an RPTO (e.g. Admin + Instructor).
CREATE TABLE IF NOT EXISTS members (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rpto_id INT NOT NULL,
  user_id INT NOT NULL,
  role ENUM('Accountable Manager','Admin','Instructor','Business Development') NOT NULL,
  dgca_cert VARCHAR(255),          -- instructor certificate upload
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY (rpto_id, user_id, role),
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS assets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rpto_id INT NOT NULL,
  type ENUM('rpas','battery','charger','simulator','classroom','field') NOT NULL,
  name VARCHAR(150) NOT NULL,       -- model / room / field name
  make VARCHAR(150),                -- manufacturer
  serial_no VARCHAR(100),
  uin VARCHAR(60),                  -- RPAS UIN
  category VARCHAR(40),             -- Rotorcraft / Aeroplane / Hybrid
  rpas_class VARCHAR(20),           -- Nano/Micro/Small/Medium
  type_certified TINYINT DEFAULT 0,
  capacity_mah INT, voltage DECIMAL(5,1),
  capacity_seats INT,               -- seats per classroom
  quantity INT DEFAULT 1,           -- identical units (chargers, classrooms, simulator seats)
  batteries_per_flight INT,         -- RPAS
  initial_cycles INT DEFAULT 0, max_cycles INT,   -- batteries: cycles before tracking, retire threshold
  location VARCHAR(255),            -- flying field address / coordinates
  acquired_on DATE,
  status ENUM('in_service','maintenance','retired') DEFAULT 'in_service',
  notes VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rpto_id INT NOT NULL,
  title VARCHAR(150) NOT NULL,
  certificate VARCHAR(40) DEFAULT 'Cat-1 [VLOS]',
  rpas_category VARCHAR(40) DEFAULT 'Rotorcraft',
  rpas_class VARCHAR(20) DEFAULT 'Small',
  batch_no VARCHAR(20),
  delivery ENUM('onsite','hybrid') DEFAULT 'onsite',
  start_date DATE, end_date DATE,
  seats INT DEFAULT 10,
  fee DECIMAL(10,2) DEFAULT 0,      -- course fee before GST
  gst_percent DECIMAL(5,2) DEFAULT 0,
  roll_seq INT DEFAULT 0,           -- atomic roll-number counter
  slot_gap_min INT DEFAULT 0,       -- timeline: minutes kept free between practical slots
  status ENUM('planned','active','completed','cancelled') DEFAULT 'planned',
  accepting TINYINT DEFAULT 1,
  records_locked TINYINT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE CASCADE
);

-- kind=instructor -> ref_id is users.id ; kind=asset -> ref_id is assets.id
CREATE TABLE IF NOT EXISTS batch_resources (
  batch_id INT NOT NULL,
  kind ENUM('instructor','asset') NOT NULL,
  ref_id INT NOT NULL,
  PRIMARY KEY (batch_id, kind, ref_id),
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS applications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rpto_id INT NOT NULL,
  batch_id INT NULL,
  user_id INT NOT NULL,
  status ENUM('pending','accepted','rejected','cancelled','withdrawn') DEFAULT 'pending',
  reason VARCHAR(255),
  roll_no VARCHAR(60),
  cert_no VARCHAR(60), cert_issued_at DATETIME,
  rpc_no VARCHAR(60), rpc_issued_at DATE,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  decided_at DATETIME,
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE CASCADE,
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Trainee KYC/eligibility documents. doc_type 'other_<n>' = extra document with its own label.
CREATE TABLE IF NOT EXISTS trainee_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  doc_type VARCHAR(40) NOT NULL,
  label VARCHAR(100),
  file VARCHAR(255),                -- NULL once purged after the RPC is issued
  original_name VARCHAR(255),
  status ENUM('pending','verified','rejected','purged') DEFAULT 'pending',
  note VARCHAR(255),
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY (user_id, doc_type),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Training syllabus. rpto_id NULL = platform default; an RPTO with its own items uses those instead.
CREATE TABLE IF NOT EXISTS syllabus_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rpto_id INT NULL,
  code VARCHAR(20) NOT NULL,
  section ENUM('theory','workshop','simulator','flying','test') NOT NULL,
  title VARCHAR(200) NOT NULL,
  minutes INT DEFAULT 60,
  needs_log TINYINT DEFAULT 0,      -- flying exercise that should carry a flight log
  sort INT DEFAULT 0,
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE CASCADE
);

-- trainee_id NULL = shared class for the whole batch; set = one trainee's simulator/flying slot.
CREATE TABLE IF NOT EXISTS sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id INT NOT NULL,
  trainee_id INT NULL,
  code VARCHAR(20),
  type ENUM('theory','workshop','simulator','flying','test') NOT NULL,
  title VARCHAR(200) NOT NULL,
  date DATE NOT NULL,
  start_time TIME, end_time TIME,
  instructor_id INT NULL,
  asset_id INT NULL,                -- RPAS / simulator / classroom used
  needs_log TINYINT DEFAULT 0,
  status ENUM('scheduled','done','cancelled') DEFAULT 'scheduled',
  notes VARCHAR(255),
  KEY (batch_id, trainee_id, type),
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE,
  FOREIGN KEY (trainee_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  session_id INT NOT NULL,
  user_id INT NOT NULL,
  present TINYINT NOT NULL,
  assessment ENUM('pass','needs_work') NULL,
  remarks VARCHAR(255),
  marked_by INT,
  marked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id, user_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- A pilot's own fleet (drones and batteries), separate from RPTO assets.
CREATE TABLE IF NOT EXISTS pilot_assets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  type ENUM('drone','battery') NOT NULL,
  name VARCHAR(150) NOT NULL,
  make VARCHAR(150), uin VARCHAR(60), serial_no VARCHAR(100),
  category VARCHAR(40), rpas_class VARCHAR(20), type_certified TINYINT DEFAULT 0,
  capacity_mah INT, voltage DECIMAL(5,1), cells INT,
  initial_cycles INT DEFAULT 0, max_cycles INT DEFAULT 300,
  acquired_on DATE,
  status ENUM('active','maintenance','retired') DEFAULT 'active',
  notes VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pilot_maintenance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  asset_id INT NOT NULL,
  date DATE NOT NULL,
  type ENUM('inspection','repair','replacement','firmware','other') DEFAULT 'inspection',
  description TEXT,
  next_due DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES pilot_assets(id) ON DELETE CASCADE
);

-- Uploaded flight logs (ArduPilot / PX4 / CSV) parsed into a GPS track for 3D replay + analysis.
CREATE TABLE IF NOT EXISTS tracks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,             -- the pilot who flew it
  uploaded_by INT NULL,
  rpto_id INT NULL,                 -- set when uploaded by RPTO staff
  file VARCHAR(255), original_name VARCHAR(255),
  format VARCHAR(20),
  started_at DATETIME,
  duration_s INT DEFAULT 0,
  distance_m INT DEFAULT 0,
  max_alt_m DECIMAL(7,1) DEFAULT 0,
  max_speed DECIMAL(6,1) DEFAULT 0,
  bat_unit VARCHAR(2),
  points JSON,                      -- [[t,lat,lon,alt,spd,hdg,bat,sats,msl,mode,climb,rcThr,rcYaw,rcPit,rcRol,volt,curr,vibe,pitch], ...]
  series JSON,                      -- downsampled chart series + rate-loop data (PID copilot)
  params JSON,                      -- flight-controller parameters found in the log
  analysis JSON,                    -- automatic flight health checks
  mission JSON,                     -- uploaded waypoints [[lat,lon,alt], ...]
  -- personal logbook ("push to logbook")
  logged TINYINT DEFAULT 0, drone_id INT NULL, battery_id INT NULL, exercise VARCHAR(200), rpic VARCHAR(150), place VARCHAR(150),
  notes VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE SET NULL,
  FOREIGN KEY (drone_id) REFERENCES pilot_assets(id) ON DELETE SET NULL,
  FOREIGN KEY (battery_id) REFERENCES pilot_assets(id) ON DELETE SET NULL
);

-- Manual pilot logbook entries (flights without a log file).
CREATE TABLE IF NOT EXISTS pilot_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  date DATE NOT NULL, start_time TIME, end_time TIME, minutes INT DEFAULT 0,
  drone_id INT NULL, battery_id INT NULL,
  place VARCHAR(150), lat DECIMAL(10,7), lon DECIMAL(10,7),
  rpic VARCHAR(150), exercise VARCHAR(200), remarks VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (drone_id) REFERENCES pilot_assets(id) ON DELETE SET NULL,
  FOREIGN KEY (battery_id) REFERENCES pilot_assets(id) ON DELETE SET NULL
);

-- Flight ops log. Training flights are written when flying attendance is marked (session_id set).
CREATE TABLE IF NOT EXISTS flight_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rpto_id INT NOT NULL,
  session_id INT NULL,
  track_id INT NULL,
  date DATE NOT NULL, time TIME,
  activity_type ENUM('training','test','maintenance','demonstration','survey','other') DEFAULT 'training',
  activity VARCHAR(150),
  pilot_id INT NULL, pilot_name VARCHAR(150),
  instructor_id INT NULL,
  rpas_id INT NULL, battery_id INT NULL, field_id INT NULL,
  place VARCHAR(150),
  minutes INT DEFAULT 0,
  remarks VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL,
  FOREIGN KEY (rpas_id) REFERENCES assets(id) ON DELETE SET NULL,
  FOREIGN KEY (battery_id) REFERENCES assets(id) ON DELETE SET NULL,
  FOREIGN KEY (field_id) REFERENCES assets(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS maintenance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rpto_id INT NOT NULL,
  asset_id INT NOT NULL,
  date DATE NOT NULL,
  type ENUM('inspection','repair','replacement','firmware','other') DEFAULT 'inspection',
  description TEXT,
  done_by VARCHAR(150),
  next_due DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sim_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  exercise VARCHAR(40) NOT NULL,
  passed TINYINT DEFAULT 0,
  seconds INT,
  penalties INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS incidents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rpto_id INT NOT NULL,
  date DATE NOT NULL, time TIME,
  field_id INT NULL, location VARCHAR(255),
  trainee_id INT NULL, instructor_id INT NULL,
  pilot_name VARCHAR(150),
  severity ENUM('minor','major','serious') DEFAULT 'minor',
  description TEXT,
  action_taken TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE CASCADE,
  FOREIGN KEY (field_id) REFERENCES assets(id) ON DELETE SET NULL,
  FOREIGN KEY (trainee_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Any assets involved in an incident (drone, battery, charger, field, ...).
CREATE TABLE IF NOT EXISTS incident_assets (
  incident_id INT NOT NULL,
  asset_id INT NOT NULL,
  PRIMARY KEY (incident_id, asset_id),
  FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS leads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rpto_id INT NOT NULL,
  name VARCHAR(150) NOT NULL,
  phone VARCHAR(30), email VARCHAR(190), city VARCHAR(100),
  source ENUM('WhatsApp','Instagram','Referral','Walk-in','Website','Phone','Manual') DEFAULT 'Manual',
  interest VARCHAR(150),
  follow_up DATE,
  notes TEXT,
  status ENUM('new','contacted','interested','converted','lost') DEFAULT 'new',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  converted_at DATETIME,
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE CASCADE
);

-- amount = total payable including GST; paid = sum of fee_payments.
CREATE TABLE IF NOT EXISTS fees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rpto_id INT NOT NULL,
  user_id INT NOT NULL,
  batch_id INT NULL,
  description VARCHAR(150) DEFAULT 'Course fee',
  amount DECIMAL(10,2) NOT NULL,
  gst_percent DECIMAL(5,2) DEFAULT 0,
  paid DECIMAL(10,2) DEFAULT 0,
  due_date DATE,
  last_paid_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY (user_id, batch_id, description),
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Each payment against a fee, with its own receipt number.
CREATE TABLE IF NOT EXISTS fee_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  fee_id INT NOT NULL,
  rpto_id INT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  mode ENUM('cash','upi','bank','card','cheque','other') DEFAULT 'upi',
  reference VARCHAR(100),
  paid_on DATE NOT NULL,
  receipt_no VARCHAR(40) NOT NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY (rpto_id, receipt_no),
  FOREIGN KEY (fee_id) REFERENCES fees(id) ON DELETE CASCADE,
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE CASCADE
);

-- rpto_id NULL = platform default bank, used by RPTOs that haven't uploaded their own.
CREATE TABLE IF NOT EXISTS questions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rpto_id INT NULL,
  subject VARCHAR(120),
  question TEXT NOT NULL,
  a VARCHAR(255) NOT NULL, b VARCHAR(255) NOT NULL, c VARCHAR(255), d VARCHAR(255),
  correct CHAR(1) NOT NULL,
  FOREIGN KEY (rpto_id) REFERENCES rptos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id INT NOT NULL,
  title VARCHAR(150) NOT NULL,
  type ENUM('theory','practical','simulator') DEFAULT 'theory',
  question_count INT DEFAULT 20,
  pass_percent INT DEFAULT 70,
  duration_min INT DEFAULT 30,
  open TINYINT DEFAULT 0,           -- theory: students can take it online while open
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS test_results (
  test_id INT NOT NULL,
  user_id INT NOT NULL,
  score INT, total INT,
  passed TINYINT,
  remarks VARCHAR(255),
  answers JSON,
  evidence_file VARCHAR(255),       -- score screenshot / scanned answer sheet
  track_id INT NULL,                -- practical test flight log
  marked_by INT NULL,
  taken_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (test_id, user_id),
  FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE SET NULL
);

-- Tutorial videos (managed by the super admin) and viewer comments.
CREATE TABLE IF NOT EXISTS tutorials (
  id INT AUTO_INCREMENT PRIMARY KEY,
  category VARCHAR(80) DEFAULT 'Getting started',
  title VARCHAR(200) NOT NULL,
  video_url VARCHAR(500),
  description TEXT,
  status ENUM('live','soon') DEFAULT 'live',
  sort INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tutorial_comments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tutorial_id INT NOT NULL,
  user_id INT NOT NULL,
  body VARCHAR(1000) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tutorial_id) REFERENCES tutorials(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS activity (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rpto_id INT NULL,
  text VARCHAR(255) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
