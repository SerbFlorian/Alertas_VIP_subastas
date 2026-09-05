// ============================================================
// TIPOS CENTRALES DEL SISTEMA — Alertas VIP Subastas
// ============================================================

// ------------------------------------------------------------
// Vehículo (Subasta del BOE y Portales Privados)
// ------------------------------------------------------------

/** Marcas de lujo que generan alertas de alto impacto */
export const MARCAS_LUJO: string[] = [
  'ferrari', 'lamborghini', 'porsche', 'bentley', 'rolls-royce', 'rolls royce',
  'maserati', 'aston martin', 'mclaren', 'bugatti', 'lotus', 'maybach',
  'tesla', 'corvette', 'dodge viper', 'amg gt', 'audi r8', 'bmw m8',
  'mercedes amg', 'nissan gt-r', 'jaguar f-type',
];

/** Representa un vehículo extraído del Portal de Subastas del BOE o portales privados */
export interface Vehiculo {
  id_subasta: string;       // Identificador único de la subasta
  portal: string;           // Origen (BOE, Escrapalia, eActivos, etc.)
  enlace: string;           // URL directa oficial
  id_lote?: string;         // Identificador del lote (si aplica)
  titulo: string;           // Descripción / Título del vehículo
  marca: string;            // Marca del vehículo
  modelo: string;           // Modelo del vehículo
  puja_minima: number;      // Puja mínima para participar
  fecha_inicio: string;     // Fecha de inicio de la subasta (ISO)
  fecha_fin: string | null; // Fecha de cierre de la subasta (ISO)
  provincia?: string;       // Provincia inferida
  comunidad_autonoma?: string; // CC.AA inferida
}

/** Representa un vehículo guardado en PostgreSQL */
export interface VehiculoDB extends Vehiculo {
  publicado_publico: boolean;
  publicado_vip: boolean;
  telegram_message_id_publico?: number;
  telegram_message_id_vip?: number;
  created_at: string;
  updated_at: string;
}

// ------------------------------------------------------------
// Scraping
// ------------------------------------------------------------

export interface ScrapingTask {
  portal: string;
  url: string;
  pagina?: number;
  extraData?: Record<string, any>;
}

export interface ScraperOptions {
  maxRetries: number;
  requestDelayMs: number;
}

/** Resultado del scraper */
export interface ScrapingResult {
  task: ScrapingTask;
  vehiculos: Vehiculo[];
  totalEncontrados: number;
  paginasEscaneadas: number;
  error?: string;
}

// ------------------------------------------------------------
// Usuarios VIP
// ------------------------------------------------------------

export type EstadoUsuario = 'Pendiente_Pago' | 'Pagado' | 'Cancelando' | 'Cancelado';

/** Usuario registrado en el sistema */
export interface UsuarioVIP {
  id?: number;
  telegram_id: string;
  email?: string;
  estado: EstadoUsuario;
  stripe_customer_id?: string;
  ai_pruebas_usadas?: number;
  ai_uso_diario?: number;
  ai_uso_semanal?: number;
  created_at?: string;
  cancel_at?: string;
}

export interface NotificacionVIPEnviada {
  id?: number;
  telegram_id: string;
  id_subasta: string;
  id_lote?: string;
  portal: string;
  telegram_message_id: number;
  enviado_at?: string;
}

// ------------------------------------------------------------
// Filtros de Usuario VIP
// ------------------------------------------------------------

export interface FiltrosUsuario {
  telegram_id: string;
  /** @deprecated Prefer marcaNorm/modeloNorm radar */
  tipos: string[];
  /** Legacy display labels; matching uses ccaaNorms */
  comunidades: string[];
  puja_maxima: number | null;
  origenes: string[];
  etiquetas: string[];
  estados: string[];
  /** VIP radar (Auto Broker–style) */
  marcaNorm?: string | null;
  modeloNorm?: string | null;
  versions?: string[];
  ccaaNorms?: string[];
  fingerprint?: string | null;
}

// ------------------------------------------------------------
// Telegram
// ------------------------------------------------------------

/** Mensaje formateado para enviar por Telegram */
export interface TelegramMensaje {
  chatId: string;
  texto: string;
  parseMode?: 'HTML' | 'Markdown';
}

// ------------------------------------------------------------
// Utilidad: Detectar coche de lujo
// ------------------------------------------------------------

/**
 * Comprueba si un vehículo es de lujo comparando su título y marca
 * contra la lista de marcas premium.
 */
export function esVehiculoDeLujo(vehiculo: Vehiculo): boolean {
  const textoCompleto = `${vehiculo.marca} ${vehiculo.modelo} ${vehiculo.titulo}`.toLowerCase();
  return MARCAS_LUJO.some(marca => textoCompleto.includes(marca));
}

/** Palabras clave bloqueadas para descartar elementos que no son vehículos (piezas, casas, barcos, etc) */
export const PALABRAS_BLOQUEADAS: string[] = [
  'despiece', 'piezas', 'recambios', 'motor de', 'chasis', 'caja de cambios',
  'inmueble', 'vivienda', 'piso', 'garaje', 'trastero', 'parcela', 'solar', 
  'nave', 'local', 'finca', 'urbana', 'rustica', 'rústica', 'edificio',
  'embarcacion', 'embarcación', 'barco', 'velero', 'yate', 'lancha', 'moto de agua', 'buque',
  'radar', 'herramientas', 'mobiliario', 'ordenador'
];

/**
 * Comprueba si un vehículo cumple con los requisitos mínimos.
 */
export function esVehiculoValido(vehiculo: Vehiculo): boolean {
  const textoCompleto = `${vehiculo.marca} ${vehiculo.modelo} ${vehiculo.titulo}`.toLowerCase();
  
  // Si contiene alguna palabra bloqueada, lo descartamos
  if (PALABRAS_BLOQUEADAS.some(palabra => textoCompleto.includes(palabra))) {
    return false;
  }
  
  // Descartar si le quedan menos de 3 horas para finalizar
  if (vehiculo.fecha_fin) {
    const fechaFinDate = new Date(vehiculo.fecha_fin);
    if (!isNaN(fechaFinDate.getTime())) {
      const tiempoRestanteMs = fechaFinDate.getTime() - Date.now();
      if (tiempoRestanteMs < 3 * 60 * 60 * 1000) {
        return false;
      }
    }
  }
  
  return true;
}
