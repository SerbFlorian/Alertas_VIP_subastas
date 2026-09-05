import type { Vehiculo } from '../types';
import { extractBrandModelFromTitle, identityLooksValid } from '../utils/brand-catalog';
import {
  canonicalizeCcaa,
  extractVersionTokens,
  normalizeBrand,
  normalizeCcaa,
  normalizeModel,
} from '../utils/normalizer';

// ============================================================
// SERVICIO DE SANITIZACIÓN Y GEOLOCALIZACIÓN
// ============================================================

const PROVINCIA_A_CCAA: Record<string, string> = {
  'alava': 'País Vasco', 'álava': 'País Vasco', 'araba': 'País Vasco',
  'albacete': 'Castilla-La Mancha',
  'alicante': 'Comunidad Valenciana', 'alacant': 'Comunidad Valenciana', 'elche': 'Comunidad Valenciana', 'torrevieja': 'Comunidad Valenciana', 'oriola': 'Comunidad Valenciana', 'orihuela': 'Comunidad Valenciana', 'benidorm': 'Comunidad Valenciana',
  'almeria': 'Andalucía', 'almería': 'Andalucía', 'roquetas': 'Andalucía', 'el ejido': 'Andalucía',
  'asturias': 'Asturias', 'gijon': 'Asturias', 'gijón': 'Asturias', 'oviedo': 'Asturias', 'aviles': 'Asturias', 'avilés': 'Asturias',
  'avila': 'Castilla y León', 'ávila': 'Castilla y León',
  'badajoz': 'Extremadura', 'merida': 'Extremadura', 'mérida': 'Extremadura',
  'barcelona': 'Cataluña', 'catalunya': 'Cataluña', 'badalona': 'Cataluña', 'terrassa': 'Cataluña', 'sabadell': 'Cataluña', 'mataro': 'Cataluña', 'mataró': 'Cataluña', 'hospitalet': 'Cataluña',
  'burgos': 'Castilla y León', 'miranda de ebro': 'Castilla y León',
  'caceres': 'Extremadura', 'cáceres': 'Extremadura',
  'cadiz': 'Andalucía', 'cádiz': 'Andalucía', 'arcos de la frontera': 'Andalucía', 'jerez': 'Andalucía', 'jerez de la frontera': 'Andalucía', 'algeciras': 'Andalucía', 'san fernando': 'Andalucía', 'el puerto de santa maria': 'Andalucía', 'el puerto': 'Andalucía',
  'cantabria': 'Cantabria', 'santander': 'Cantabria', 'torrelavega': 'Cantabria',
  'castellon': 'Comunidad Valenciana', 'castelló': 'Comunidad Valenciana', 'castellón': 'Comunidad Valenciana',
  'ciudad real': 'Castilla-La Mancha', 'puertollano': 'Castilla-La Mancha',
  'cordoba': 'Andalucía', 'córdoba': 'Andalucía', 'lucena': 'Andalucía',
  'a coruna': 'Galicia', 'a coruña': 'Galicia', 'la coruña': 'Galicia', 'santiago': 'Galicia', 'santiago de compostela': 'Galicia', 'ferrol': 'Galicia',
  'cuenca': 'Castilla-La Mancha',
  'girona': 'Cataluña', 'gerona': 'Cataluña',
  'granada': 'Andalucía', 'motril': 'Andalucía',
  'guadalajara': 'Castilla-La Mancha',
  'gipuzkoa': 'País Vasco', 'guipuzcoa': 'País Vasco', 'guipúzcoa': 'País Vasco', 'san sebastian': 'País Vasco', 'donostia': 'País Vasco', 'irun': 'País Vasco', 'irún': 'País Vasco',
  'huelva': 'Andalucía',
  'huesca': 'Aragón',
  'illes balears': 'Baleares', 'islas baleares': 'Baleares', 'baleares': 'Baleares', 'mallorca': 'Baleares', 'ibiza': 'Baleares', 'palma': 'Baleares', 'manacor': 'Baleares',
  'jaen': 'Andalucía', 'jaén': 'Andalucía', 'linares': 'Andalucía',
  'leon': 'Castilla y León', 'león': 'Castilla y León', 'ponferrada': 'Castilla y León',
  'lleida': 'Cataluña', 'lerida': 'Cataluña', 'lérida': 'Cataluña',
  'lugo': 'Galicia',
  'madrid': 'Comunidad de Madrid', 'mostoles': 'Comunidad de Madrid', 'móstoles': 'Comunidad de Madrid', 'alcala de henares': 'Comunidad de Madrid', 'alcalá de henares': 'Comunidad de Madrid', 'fuenlabrada': 'Comunidad de Madrid', 'leganes': 'Comunidad de Madrid', 'leganés': 'Comunidad de Madrid', 'getafe': 'Comunidad de Madrid', 'alcorcon': 'Comunidad de Madrid', 'alcorcón': 'Comunidad de Madrid', 'parla': 'Comunidad de Madrid', 'torrejon': 'Comunidad de Madrid', 'torrejón': 'Comunidad de Madrid', 'alcobendas': 'Comunidad de Madrid', 'las rozas': 'Comunidad de Madrid', 'pozuelo': 'Comunidad de Madrid', 'majadahonda': 'Comunidad de Madrid',
  'malaga': 'Andalucía', 'málaga': 'Andalucía', 'marbella': 'Andalucía', 'mijas': 'Andalucía', 'fuengirola': 'Andalucía', 'torremolinos': 'Andalucía', 'antequera': 'Andalucía', 'ronda': 'Andalucía',
  'murcia': 'Región de Murcia', 'cartagena': 'Región de Murcia', 'lorca': 'Región de Murcia',
  'navarra': 'Navarra', 'nafarroa': 'Navarra', 'tudela': 'Navarra',
  'ourense': 'Galicia', 'orense': 'Galicia',
  'palencia': 'Castilla y León',
  'las palmas': 'Canarias', 'gran canaria': 'Canarias', 'fuerteventura': 'Canarias', 'lanzarote': 'Canarias', 'telde': 'Canarias', 'arrecife': 'Canarias',
  'pontevedra': 'Galicia', 'vigo': 'Galicia',
  'la rioja': 'La Rioja', 'rioja': 'La Rioja', 'logroño': 'La Rioja',
  'salamanca': 'Castilla y León',
  'segovia': 'Castilla y León',
  'sevilla': 'Andalucía', 'dos hermanas': 'Andalucía', 'alcala de guadaira': 'Andalucía', 'alcalá de guadaira': 'Andalucía',
  'soria': 'Castilla y León',
  'tarragona': 'Cataluña', 'reus': 'Cataluña',
  'santa cruz de tenerife': 'Canarias', 'tenerife': 'Canarias', 'la laguna': 'Canarias', 'arona': 'Canarias',
  'teruel': 'Aragón',
  'toledo': 'Castilla-La Mancha', 'talavera': 'Castilla-La Mancha', 'talavera de la reina': 'Castilla-La Mancha',
  'valencia': 'Comunidad Valenciana', 'torrent': 'Comunidad Valenciana', 'torrente': 'Comunidad Valenciana', 'gandia': 'Comunidad Valenciana', 'gandía': 'Comunidad Valenciana', 'paterna': 'Comunidad Valenciana', 'sagunto': 'Comunidad Valenciana',
  'valladolid': 'Castilla y León',
  'bizkaia': 'País Vasco', 'vizcaya': 'País Vasco', 'bilbao': 'País Vasco', 'barakaldo': 'País Vasco', 'getxo': 'País Vasco',
  'zamora': 'Castilla y León',
  'zaragoza': 'Aragón',
  'ceuta': 'Ceuta',
  'melilla': 'Melilla'
};

/**
 * Infiere la Comunidad Autónoma a partir de un texto (ej. ubicación o juzgado)
 */
export function inferirUbicacion(texto?: string): { provincia?: string; ccaa?: string } {
  if (!texto) return {};
  
  const textoLower = texto.toLowerCase();
  
  // Buscar de la provincia más larga a la más corta para evitar falsos positivos
  const provincias = Object.keys(PROVINCIA_A_CCAA).sort((a, b) => b.length - a.length);
  
  for (const prov of provincias) {
    if (textoLower.includes(prov)) {
      // Devolver el nombre de la provincia formateado
      const provCapitalizada = prov.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      return {
        provincia: provCapitalizada,
        ccaa: PROVINCIA_A_CCAA[prov]
      };
    }
  }
  
  return {};
}

/**
 * Sanitiza un texto para cumplir con la LOPD/RGPD.
 * Elimina DNI/NIEs, teléfonos, y posibles nombres completos.
 */
export function sanitizarTextoLegal(texto?: string): string {
  if (!texto) return '';
  
  let sanitizado = texto;

  // 1. Ocultar DNI / NIE (8 números + 1 Letra, o Letra + 7 números + Letra)
  // Ej: 12345678A, X1234567Z
  const dniRegex = /[0-9]{8}[A-Za-z]|[XYZxyz][0-9]{7}[A-Za-z]/g;
  sanitizado = sanitizado.replace(dniRegex, '[OCULTO POR RGPD]');
  
  // 2. Ocultar teléfonos (opcional pero recomendado)
  const phoneRegex = /(?:(?:\+34|0034|34)\s?)?(?:[6789]\d{2}(?:\s?\d{2}){3}|[6789]\d{8})/g;
  sanitizado = sanitizado.replace(phoneRegex, '[TELÉFONO OCULTO]');

  // 3. Ocultar Nombres propios si van precedidos de "D.", "Doña", "Don", "Sr.", "Sra."
  const nombreRegex = /(?:D\.|Dña\.|Don|Doña|Sr\.|Sra\.)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?/g;
  sanitizado = sanitizado.replace(nombreRegex, '[IDENTIDAD OCULTA]');
  
  // 4. Ocultar NIF de empresas/personas si se menciona "NIF" o "CIF"
  const cifRegex = /(?:NIF|CIF|N\.I\.F\.|C\.I\.F\.)\s*[:\-]?\s*([A-Za-z0-9]{9})/gi;
  sanitizado = sanitizado.replace(cifRegex, 'NIF/CIF: [OCULTO POR RGPD]');

  return sanitizado;
}

export interface VehiculoEnriquecido extends Vehiculo {
  marcaNorm: string;
  modeloNorm: string;
  versionTokens: string[];
  ccaaNorm: string;
}

/**
 * Aplica filtros legales, geo canónica y norms antes de persistir.
 */
export function procesarVehiculo(v: Vehiculo): VehiculoEnriquecido {
  const geo = inferirUbicacion(v.provincia || v.titulo || '');
  const ccaaDisplay = canonicalizeCcaa(geo.ccaa || v.comunidad_autonoma || '');
  const titulo = sanitizarTextoLegal(v.titulo);
  let marca = (v.marca || '').trim();
  let modelo = (v.modelo || '').trim();

  // Si marca/modelo basura → intentar desde título con catálogo
  if (!identityLooksValid(marca, modelo)) {
    const parsed = extractBrandModelFromTitle(titulo || v.titulo);
    if (parsed) {
      marca = parsed.marca;
      modelo = parsed.modelo;
    }
  }

  return {
    ...v,
    marca,
    modelo,
    titulo,
    provincia: geo.provincia || v.provincia,
    comunidad_autonoma: ccaaDisplay || v.comunidad_autonoma,
    marcaNorm: normalizeBrand(marca),
    modeloNorm: normalizeModel(modelo),
    versionTokens: extractVersionTokens(titulo, modelo),
    ccaaNorm: normalizeCcaa(ccaaDisplay || v.comunidad_autonoma),
  };
}
