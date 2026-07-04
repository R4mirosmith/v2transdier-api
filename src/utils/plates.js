export function normalizePlate(plate) {
  return String(plate || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/-/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

export function classifyColombianPlate(plate) {
  const normalized = normalizePlate(plate);
  const motorcyclePattern = /^[A-Z]{3}[0-9]{2}[A-Z]$/;
  const vehiclePattern = /^[A-Z]{3}[0-9]{3}$/;

  if (motorcyclePattern.test(normalized)) {
    return {
      ok: true,
      normalized,
      category: 'MOTORCYCLE',
      label: 'moto',
      example: 'ABC12D'
    };
  }

  if (vehiclePattern.test(normalized)) {
    return {
      ok: true,
      normalized,
      category: 'VEHICLE',
      label: 'vehículo',
      example: 'ABC123'
    };
  }

  return {
    ok: false,
    normalized,
    category: 'UNKNOWN',
    label: 'desconocido',
    message: 'Formato de placa inválido. Moto: 3 letras + 2 números + 1 letra, ejemplo ABC12D. Vehículo: 3 letras + 3 números, ejemplo ABC123.'
  };
}

export function vehicleTypePlateCategory(vehicleType = {}) {
  const code = String(vehicleType.code || '').toUpperCase();
  const name = String(vehicleType.name || '').toUpperCase();
  return code.includes('MOTO') || name.includes('MOTO') ? 'MOTORCYCLE' : 'VEHICLE';
}

export function validatePlate(plate) {
  const classified = classifyColombianPlate(plate);
  if (!classified.normalized) {
    return { ok: false, normalized: classified.normalized, message: 'La placa es obligatoria.' };
  }
  if (!classified.ok) {
    return { ok: false, normalized: classified.normalized, message: classified.message };
  }
  return { ok: true, normalized: classified.normalized, category: classified.category };
}

export function validatePlateMatchesVehicleType(plate, vehicleType) {
  const classified = classifyColombianPlate(plate);
  if (!classified.ok) return classified;

  const expectedCategory = vehicleTypePlateCategory(vehicleType);
  if (classified.category !== expectedCategory) {
    const typeName = vehicleType?.name || 'el tipo seleccionado';
    if (expectedCategory === 'MOTORCYCLE') {
      return {
        ok: false,
        normalized: classified.normalized,
        category: classified.category,
        expectedCategory,
        message: `La placa ${classified.normalized} tiene formato de vehículo/carro. No puede registrarse como ${typeName}. Para moto usa 3 letras + 2 números + 1 letra, ejemplo ABC12D.`
      };
    }
    return {
      ok: false,
      normalized: classified.normalized,
      category: classified.category,
      expectedCategory,
      message: `La placa ${classified.normalized} tiene formato de moto. No puede registrarse como ${typeName}. Para vehículos usa 3 letras + 3 números, ejemplo ABC123.`
    };
  }

  return { ok: true, normalized: classified.normalized, category: classified.category, expectedCategory };
}
