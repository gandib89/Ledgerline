import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { withTenantScope } from './tenant-extension.js';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = withTenantScope(new PrismaClient({ adapter }));

