-- ble-tool D1 schema：用户 / 设备 / 寄存器配置
-- 设备为全局共享（管理员配置，所有登录用户可用）；写操作仅管理员

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pw TEXT NOT NULL,              -- pbkdf2$iterations$salt$hash
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ble_name TEXT NOT NULL DEFAULT '',
  slave INTEGER NOT NULL,
  word_order TEXT NOT NULL DEFAULT 'ABCD',
  tx_svc TEXT NOT NULL DEFAULT '',
  tx_char TEXT NOT NULL DEFAULT '',
  rx_svc TEXT NOT NULL DEFAULT '',
  rx_char TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS registers (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address INTEGER NOT NULL,
  reg_type TEXT NOT NULL,        -- readonly | writeonly | readwrite
  data_type TEXT NOT NULL,       -- uint16|int16|uint32|int32|float32
  unit TEXT NOT NULL DEFAULT '',
  scale REAL NOT NULL DEFAULT 1,
  offset REAL NOT NULL DEFAULT 0,
  options TEXT NOT NULL DEFAULT '', -- 选择型寄存器的写入选项：JSON {"0":"周期测量"} 或 "0=周期测量,6=校准模式"
  read_options TEXT NOT NULL DEFAULT '', -- 选择型寄存器的读取选项：JSON {"1":"周期测量模式"}（读回值与写入值不一致时用）
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_registers_device ON registers(device_id);
