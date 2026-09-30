import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SPEC_VERSION = '1.6';
const APP_COMPONENT_NAME = 'kilo-app';
const ARTIFACT_HASH_SOURCE = 'hash of the downloaded file that is submitted to the store';
const SHA256_RE = /^[0-9a-f]{64}$/;
const LINKAGE_PROPERTIES = [
  'kilo:sbom:platform',
  'kilo:sbom:app-version',
  'kilo:sbom:build-number',
  'kilo:sbom:eas-build-id',
  'kilo:sbom:artifact-sha256',
];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function requirePlatform(platform, context) {
  if (platform !== 'ios' && platform !== 'android') {
    throw new Error(
      `${context}: platform must be "ios" or "android", got ${JSON.stringify(platform)}`
    );
  }
}

export function sha256File(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(`cannot hash ${path}: ${error.message}`);
  }
  return createHash('sha256').update(bytes).digest('hex');
}

export function sbomFileName({ platform, appVersion, appBuildVersion } = {}) {
  requirePlatform(platform, 'sbomFileName');
  if (!isNonEmptyString(appVersion)) {
    throw new Error('sbomFileName: appVersion must be a non-empty string');
  }
  if (!isNonEmptyString(appBuildVersion)) {
    throw new Error('sbomFileName: appBuildVersion must be a non-empty string');
  }
  return `kilo-app-${platform}-${appVersion}-build${appBuildVersion}.cyclonedx.json`;
}

export function toCycloneDxComponents(readerComponents) {
  if (!Array.isArray(readerComponents)) {
    throw new Error('toCycloneDxComponents: readerComponents must be an array');
  }
  const refCounts = new Map();
  return readerComponents.map(entry => {
    if (!entry || typeof entry !== 'object') {
      throw new Error('toCycloneDxComponents: every component must be an object');
    }
    const { ecosystem, name, version, purl, hashes, extraProperties } = entry;
    if (!isNonEmptyString(ecosystem)) {
      throw new Error('toCycloneDxComponents: component.ecosystem must be a non-empty string');
    }
    if (!isNonEmptyString(name)) {
      throw new Error('toCycloneDxComponents: component.name must be a non-empty string');
    }
    if (!isNonEmptyString(purl)) {
      throw new Error('toCycloneDxComponents: component.purl must be a non-empty string');
    }
    // CycloneDX requires bom-ref to be unique within a document; duplicate purls
    // are the only collision the reader shape can produce.
    const occurrence = (refCounts.get(purl) ?? 0) + 1;
    refCounts.set(purl, occurrence);
    return {
      type: 'library',
      name,
      ...(version === null || version === undefined ? {} : { version }),
      purl,
      'bom-ref': occurrence === 1 ? purl : `${purl}#${occurrence}`,
      scope: 'required',
      properties: [
        { name: 'kilo:sbom:ecosystem', value: ecosystem },
        ...(Array.isArray(extraProperties) ? extraProperties : []),
      ],
      hashes: Array.isArray(hashes) ? hashes : [],
    };
  });
}

export function buildCycloneDxDocument({
  platform,
  appName,
  appVersion,
  appBuildVersion,
  easBuildId,
  artifactName,
  artifactSha256,
  components,
  sources = [],
}) {
  requirePlatform(platform, 'buildCycloneDxDocument');
  if (!isNonEmptyString(appVersion)) {
    throw new Error('buildCycloneDxDocument: appVersion must be a non-empty string');
  }
  if (!isNonEmptyString(appBuildVersion)) {
    throw new Error('buildCycloneDxDocument: appBuildVersion must be a non-empty string');
  }
  if (!isNonEmptyString(easBuildId)) {
    throw new Error('buildCycloneDxDocument: easBuildId must be a non-empty string');
  }
  if (typeof artifactSha256 !== 'string' || !SHA256_RE.test(artifactSha256)) {
    throw new Error(
      `buildCycloneDxDocument: artifactSha256 must be a lowercase 64-character hex string, got ${JSON.stringify(artifactSha256)}`
    );
  }
  if (!Array.isArray(components)) {
    throw new Error('buildCycloneDxDocument: components must be an array');
  }
  if (!Array.isArray(sources)) {
    throw new Error('buildCycloneDxDocument: sources must be an array');
  }
  const sourceProperties = sources.map(source => {
    if (!source || !isNonEmptyString(source.ecosystem) || !isNonEmptyString(source.source)) {
      throw new Error(
        'buildCycloneDxDocument: every source needs a non-empty ecosystem and source'
      );
    }
    return { name: `kilo:sbom:source:${source.ecosystem}`, value: source.source };
  });
  const componentName = isNonEmptyString(appName) ? appName : APP_COMPONENT_NAME;
  return {
    bomFormat: 'CycloneDX',
    specVersion: SPEC_VERSION,
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        type: 'application',
        name: componentName,
        version: appVersion,
        'bom-ref': `pkg:generic/${componentName}@${appVersion}`,
        properties: [{ name: 'kilo:sbom:build-number', value: appBuildVersion }],
      },
      properties: [
        { name: 'kilo:sbom:platform', value: platform },
        { name: 'kilo:sbom:app-version', value: appVersion },
        { name: 'kilo:sbom:build-number', value: appBuildVersion },
        { name: 'kilo:sbom:eas-build-id', value: easBuildId },
        {
          name: 'kilo:sbom:artifact-name',
          value: isNonEmptyString(artifactName) ? artifactName : '',
        },
        { name: 'kilo:sbom:artifact-sha256', value: artifactSha256 },
        { name: 'kilo:sbom:artifact-sha256-source', value: ARTIFACT_HASH_SOURCE },
        ...sourceProperties,
      ],
    },
    components,
  };
}

export function assertCycloneDxDocument(doc) {
  if (!doc || typeof doc !== 'object') {
    throw new Error('assertCycloneDxDocument: document must be an object');
  }
  if (doc.bomFormat !== 'CycloneDX') {
    throw new Error(
      `assertCycloneDxDocument: bomFormat must be "CycloneDX", got ${JSON.stringify(doc.bomFormat)}`
    );
  }
  if (!isNonEmptyString(doc.specVersion)) {
    throw new Error('assertCycloneDxDocument: specVersion must be set');
  }
  if (!doc.metadata || !doc.metadata.component) {
    throw new Error('assertCycloneDxDocument: metadata.component must be set');
  }
  const properties = Array.isArray(doc.metadata.properties) ? doc.metadata.properties : [];
  const names = new Set(properties.map(property => property?.name));
  for (const required of LINKAGE_PROPERTIES) {
    if (!names.has(required)) {
      throw new Error(`assertCycloneDxDocument: missing linkage property ${required}`);
    }
  }
  return doc;
}
