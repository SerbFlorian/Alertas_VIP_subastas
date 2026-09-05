#!/bin/bash
echo "🔒 Aplicando permisos restrictivos a .env..."
chmod 600 .env

echo "🚀 Iniciando despliegue con Docker Compose..."
docker compose up -d --build

echo "✅ Despliegue completado con éxito."
