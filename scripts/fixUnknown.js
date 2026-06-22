import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  // Find the FollowUp that has "Unknown Campaign"
  const followUps = await prisma.followUp.findMany({
    where: { message: { contains: 'Unknown Campaign' } }
  });

  for (const f of followUps) {
    await prisma.followUp.update({
      where: { id: f.id },
      data: { message: f.message.replace('Unknown Campaign', 'sri eshwar') }
    });
    console.log(`Updated FollowUp ${f.id}`);
  }

  // Find the Lead that has "Unknown Campaign" in nextAction
  const leads = await prisma.lead.findMany({
    where: { nextAction: { contains: 'Unknown Campaign' } }
  });

  for (const l of leads) {
    await prisma.lead.update({
      where: { id: l.id },
      data: { nextAction: l.nextAction.replace('Unknown Campaign', 'sri eshwar') }
    });
    console.log(`Updated Lead ${l.id}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
