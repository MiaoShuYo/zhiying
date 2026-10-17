const { resolve } = require('node:path');
const { mkdirSync } = require('node:fs');
const { PrismaClient } = require('../apps/web/node_modules/@prisma/client');
require('../apps/worker/node_modules/dotenv').config({ path: resolve(__dirname, '../apps/web/.env'), quiet: true });
const database = process.env.DATABASE_URL;
if (!database?.startsWith('file:')) throw new Error('V1.1 迁移仅支持本地 SQLite');
const location = database.slice(5);
const dbPath = resolve(__dirname, '../apps/web/prisma', location);
const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath.replaceAll('\\', '/')}` } } });
async function migrate() {
  const project = await prisma.$queryRawUnsafe('PRAGMA table_info("Project")');
  const job = await prisma.$queryRawUnsafe('PRAGMA table_info("Job")');
  if (!project.length || !job.length) throw new Error('数据库尚未初始化，请先运行 pnpm db:push');
  const changes = [!project.some(column => column.name === 'revision') && 'ALTER TABLE "Project" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0', !job.some(column => column.name === 'inputJson') && 'ALTER TABLE "Job" ADD COLUMN "inputJson" TEXT', !job.some(column => column.name === 'outputPath') && 'ALTER TABLE "Job" ADD COLUMN "outputPath" TEXT'].filter(Boolean);
  if (!changes.length) { console.log('V1.1 数据库已是最新版本'); return; }
  const backupDir = resolve(__dirname, '../data/database-backups'); mkdirSync(backupDir, { recursive: true });
  const backup = resolve(backupDir, `before-v11-${Date.now()}.db`);
  await prisma.$executeRawUnsafe('VACUUM INTO ?', backup);
  await prisma.$transaction(changes.map(sql => prisma.$executeRawUnsafe(sql)));
  console.log(`V1.1 增量迁移完成，迁移前数据库：${backup}`);
}
migrate().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
