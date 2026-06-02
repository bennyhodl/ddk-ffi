#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Parse ddk-ffi lib.rs for the exported UniFFI types (records / enums / errors).
// Source of truth is the Rust proc-macros (there is no longer a .udl).
function parseUniffiTypes(libPath) {
  const content = fs.readFileSync(libPath, 'utf8');
  const types = { records: [], enums: [], errors: [] };

  for (const m of content.matchAll(/#\[derive\(([^)]*)\)\]\s*\npub (struct|enum) (\w+)/g)) {
    const derives = m[1];
    const name = m[3];
    if (/\buniffi::Record\b/.test(derives)) types.records.push(name);
    else if (/\buniffi::Error\b/.test(derives)) types.errors.push(name);
    else if (/\buniffi::Enum\b/.test(derives)) types.enums.push(name);
  }
  return types;
}

// Parse ddk-ts types.rs for #[napi(object)] structs
function parseNAPITypes(typesPath) {
  const content = fs.readFileSync(typesPath, 'utf8');
  return [
    ...content.matchAll(/#\[napi\(object\)\]\s*(?:#\[derive[^\]]+\]\s*)?pub\s+struct\s+(\w+)/g),
  ].map((m) => m[1]);
}

function verifyTypes() {
  const ffiLibPath = path.join(__dirname, '../../ddk-ffi/src/lib.rs');
  const typesPath = path.join(__dirname, '../src/types.rs');

  console.log('🔍 Verifying NAPI-RS type definitions...\n');

  const uniffiTypes = parseUniffiTypes(ffiLibPath);
  console.log(
    `📋 ddk-ffi: ${uniffiTypes.records.length} records, ${uniffiTypes.enums.length} enums, ${uniffiTypes.errors.length} errors`,
  );
  uniffiTypes.records.forEach((t) => console.log(`   - ${t}`));
  console.log();

  const napiTypes = parseNAPITypes(typesPath);
  console.log(`🦀 Found ${napiTypes.length} #[napi(object)] types in ddk-ts:`);
  napiTypes.forEach((t) => console.log(`   - ${t}`));
  console.log();

  // Every ddk-ffi record must have a matching NAPI object type.
  // (Enums/errors are surfaced differently in NAPI and are not compared here.)
  const napiSet = new Set(napiTypes);
  const missingTypes = uniffiTypes.records.filter((t) => !napiSet.has(t));

  console.log('📊 Type Verification Results:\n');

  if (missingTypes.length > 0) {
    console.error('❌ ddk-ffi records missing in ddk-ts NAPI:');
    missingTypes.forEach((type) => console.error(`   - ${type}`));
    console.log();
    process.exit(1);
  } else {
    console.log('✅ All ddk-ffi record types are defined in ddk-ts NAPI!');
  }

  console.log('\n📈 Summary:');
  console.log(`   ddk-ffi records: ${uniffiTypes.records.length}`);
  console.log(`   ddk-ts NAPI types: ${napiTypes.length}`);
}

try {
  verifyTypes();
} catch (error) {
  console.error('❌ Error during type verification:', error.message);
  process.exit(1);
}
