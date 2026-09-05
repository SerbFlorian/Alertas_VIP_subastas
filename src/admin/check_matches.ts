import { prisma } from '../db/prisma';
import { getAllUsuariosFiltros } from '../db/filters.queries';

const DICCIONARIO_CATEGORIAS: Record<string, string[]> = {
  motos: [
    'moto', 'motocicleta', 'ciclomotor', 'scooter', 'scóoter', 'vespa',
    'yamaha', 'honda', 'kawasaki', 'suzuki', 'bmw r', 'duke', 't-max', 'tmax',
    'kymco', 'piaggio', 'sym', 'aprilia', 'harley', 'ducati', 'ktm'
  ],
  furgonetas: [
    'furgon', 'furgón', 'furgoneta', 'comercial', 'mixto', 'chasis cabina',
    'berlingo', 'partner', 'rifter', 'kangoo', 'express', 'transit', 'tourneo',
    'caddy', 'transporter', 'caravelle', 'multivan', 'california', 'vito',
    'viano', 'clase v', 'sprinter', 'ducato', 'scudo', 'doblò', 'doblo',
    'boxer', 'jumper', 'crafter', 'master', 'trafic', 'movano', 'vivaro',
    'nv200', 'nv300', 'nv400', 'interstar', 'primastar', 'custom', 'proace'
  ],
  turismos: [
    'turismo', 'compacto', 'sedan', 'sedán', 'berlina', 'coupe', 'coupé',
    'cabrio', 'hatchback', 'familiar', 'break', 'sw', 'avant', 'tourer',
    'golf', 'polo', 'passat', 'ibiza', 'leon', 'león', 'clio', 'megane',
    'mégane', 'fiesta', 'focus', 'corsa', 'astra', 'c3', 'c4', '308', '208',
    'serie 1', 'serie 3', 'clase a', 'clase c', 'a3', 'a4'
  ],
  suvs: [
    'suv', '4x4', 'todo terreno', 'todoterreno', 'todocamino', 'crossover',
    'qashqai', 'tucson', 'sportage', 'rav4', 'tiguan', 'ateca', 'arona',
    '3008', '2008', 'duster', 'kadjar', 'kuga', 'x1', 'x3', 'x5', 'q3', 'q5',
    'q7', 'gla', 'glc', 'land cruiser', 'range rover', 'evoque', 'cherokee',
    'wrangler', 'jimny', 'vitara', 'renegade'
  ],
  industriales: [
    'camion', 'camión', 'cuba', 'volquete', 'grúa', 'grua', 'plataforma',
    'hormigonera', 'cesta', 'tractocamion', 'tractocamión', 'cabeza tractora',
    'trailer', 'tráiler', 'caja abierta', 'caja cerrada', 'carretilla',
    'torito', 'excavadora', 'pala', 'retroexcavadora', 'dumpers', 'dumper',
    'tractor', 'iveco', 'man', 'scania', 'volvo fh', 'daf', 'renault trucks',
    'mercedes actros'
  ]
};

function coincideTipoVehiculo(vehiculoText: string, tipoFiltro: string): boolean {
  const text = vehiculoText.toLowerCase();
  const tipoLower = tipoFiltro.toLowerCase();

  if (tipoLower.includes('moto') || tipoLower.includes('ciclomotor') || tipoLower.includes('scooter')) {
    return DICCIONARIO_CATEGORIAS['motos']!.some(kw => text.includes(kw));
  }
  if (tipoLower.includes('furgoneta') || tipoLower.includes('comercial') || tipoLower.includes('furgón')) {
    return DICCIONARIO_CATEGORIAS['furgonetas']!.some(kw => text.includes(kw));
  }
  if (tipoLower.includes('turismo') || tipoLower.includes('compacto') || tipoLower.includes('coche')) {
    return DICCIONARIO_CATEGORIAS['turismos']!.some(kw => text.includes(kw));
  }
  if (tipoLower.includes('suv') || tipoLower.includes('4x4') || tipoLower.includes('todoterreno')) {
    return DICCIONARIO_CATEGORIAS['suvs']!.some(kw => text.includes(kw));
  }
  if (tipoLower.includes('industrial') || tipoLower.includes('camion') || tipoLower.includes('camión')) {
    return DICCIONARIO_CATEGORIAS['industriales']!.some(kw => text.includes(kw));
  }
  return true;
}

async function checkMatches() {
  console.log('🔍 ANALIZANDO COMPATIBILIDAD DE SUBASTAS CON FILTROS DE USUARIOS...\n');

  const vehiculos = await prisma.vehiculo.findMany();
  console.log(`📦 Total vehículos en Base de Datos: ${vehiculos.length}`);

  const usuariosFiltros = await getAllUsuariosFiltros();
  console.log(`👥 Total usuarios con filtros configurados: ${usuariosFiltros.length}\n`);

  if (usuariosFiltros.length === 0) {
    console.log('⚠️ No hay usuarios con filtros en la BD.');
    await prisma.$disconnect();
    return;
  }

  for (const u of usuariosFiltros) {
    console.log(`============================================================`);
    console.log(`👤 Usuario Telegram ID: ${u.telegram_id}`);
    console.log(`🚗 Tipos seleccionados: ${u.tipos.length > 0 ? u.tipos.join(', ') : 'Todos'}`);
    console.log(`📍 Comunidades: ${u.comunidades.length > 0 ? u.comunidades.join(', ') : 'Toda España'}`);
    console.log(`💰 Puja Máxima: ${u.puja_maxima ? u.puja_maxima + '€' : 'Cualquiera'}`);
    console.log(`============================================================\n`);

    let compatibles = 0;
    let descartadosPorPrecio = 0;
    let descartadosPorCCAA = 0;
    let descartadosPorTipo = 0;

    const listaCompatibles: any[] = [];

    for (const v of vehiculos) {
      const textoCompleto = `${v.titulo} ${v.marca} ${v.modelo}`.toLowerCase();

      // 1. Filtro de Tipo
      if (u.tipos && u.tipos.length > 0) {
        const coincide = u.tipos.some(t => coincideTipoVehiculo(textoCompleto, t));
        if (!coincide) {
          descartadosPorTipo++;
          continue;
        }
      }

      // 2. Filtro de CCAA
      if (u.comunidades && u.comunidades.length > 0) {
        if (!v.comunidad_autonoma || !u.comunidades.includes(v.comunidad_autonoma)) {
          descartadosPorCCAA++;
          continue;
        }
      }

      // 3. Filtro de Puja Máxima
      if (u.puja_maxima !== null && v.puja_minima > u.puja_maxima) {
        descartadosPorPrecio++;
        continue;
      }

      compatibles++;
      listaCompatibles.push(v);
    }

    console.log(`📊 RESULTADOS PARA EL USUARIO ${u.telegram_id}:`);
    console.log(`✅ COMPATIBLES: ${compatibles} de ${vehiculos.length} vehículos (${((compatibles / (vehiculos.length || 1)) * 100).toFixed(1)}%)`);
    console.log(`❌ Descartados por CCAA distintas: ${descartadosPorCCAA}`);
    console.log(`❌ Descartados por Tipo distinto: ${descartadosPorTipo}`);
    console.log(`❌ Descartados por Exceso de Puja Máxima: ${descartadosPorPrecio}\n`);

    if (listaCompatibles.length > 0) {
      console.log(`🚗 LISTADO DE VEHÍCULOS MATCHING:`);
      listaCompatibles.forEach((v, index) => {
        console.log(`  ${index + 1}. [${v.portal}] ${v.titulo} | 💰 Puja: ${v.puja_minima}€ | 📍 CCAA: ${v.comunidad_autonoma || 'Sin CCAA'}`);
      });
      console.log('\n');
    }
  }

  await prisma.$disconnect();
}

checkMatches().catch(console.error);
