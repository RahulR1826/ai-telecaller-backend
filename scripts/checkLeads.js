import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const leads = await prisma.lead.findMany({
    orderBy: { updatedAt: 'desc' },
    take: 5,
    include: { campaign: true }
  });
  console.log("Recent leads:");
  leads.forEach(l => {
    console.log(`- ${l.phone}: status=${l.status}, nextAction="${l.nextAction}", campaignId=${l.campaignId}, campaignName=${l.campaign?.name}`);
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
