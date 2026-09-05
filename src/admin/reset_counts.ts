import { prisma } from '../db/prisma';

async function resetCounts() {
  console.log('🔄 Reiniciando estado de publicaciones en Telegram...');

  // 1. Resetear flags globales de publicación en la tabla vehiculos
  const resVehiculos = await prisma.vehiculo.updateMany({
    data: {
      publicado_publico: false,
      publicado_vip: false,
      telegram_message_id_publico: null,
      telegram_message_id_vip: null
    }
  });

  // 2. Limpiar el historial de notificaciones 1-a-1 enviadas a usuarios VIP
  const resNotificaciones = await prisma.notificacionVIPEnviada.deleteMany({});

  console.log(`✅ Estado de Telegram reiniciado correctamente:`);
  console.log(`   - ${resVehiculos.count} vehículos marcados como NO publicados (publicado_publico=false, publicado_vip=false).`);
  console.log(`   - ${resNotificaciones.count} registros de notificaciones VIP individuales eliminados.`);

  await prisma.$disconnect();
}

resetCounts().catch((err) => {
  console.error('❌ Error reiniciando estado de Telegram:', err);
  prisma.$disconnect();
  process.exit(1);
});
