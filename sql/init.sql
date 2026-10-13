-- Aurora Console 导航站数据库初始化脚本
-- 使用：mysql -u home_nav -p home_nav < init.sql

CREATE DATABASE IF NOT EXISTS home_nav DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE home_nav;

-- 分类表
CREATE TABLE IF NOT EXISTS categories (
  id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  icon VARCHAR(50) DEFAULT 'Folder',
  sort INT DEFAULT 0,
  hidden TINYINT DEFAULT 0,
  created_at VARCHAR(20) DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 站点表
CREATE TABLE IF NOT EXISTS sites (
  id VARCHAR(32) PRIMARY KEY,
  category_id VARCHAR(32) DEFAULT '',
  name VARCHAR(100) NOT NULL,
  url VARCHAR(500) DEFAULT '',
  description VARCHAR(500) DEFAULT '',
  icon VARCHAR(500) DEFAULT '',
  note VARCHAR(500) DEFAULT '',
  sort INT DEFAULT 0,
  hidden TINYINT DEFAULT 0,
  down TINYINT DEFAULT 0,
  auto_down TINYINT DEFAULT 0,
  created_at VARCHAR(20) DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 全局设置（JSON）
CREATE TABLE IF NOT EXISTS settings (
  id INT PRIMARY KEY,
  data LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 键值存储（pins 钉选 / recent 访问记录）
CREATE TABLE IF NOT EXISTS kv (
  k VARCHAR(32) PRIMARY KEY,
  v LONGTEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 数据版本号（SSE 广播用）
CREATE TABLE IF NOT EXISTS meta (
  k VARCHAR(16) PRIMARY KEY,
  v BIGINT DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO meta (k, v) VALUES ('version', 1);
