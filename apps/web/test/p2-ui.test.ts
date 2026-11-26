/**
 * P2 #311: GFDL is reviewed like other licences, not treated as public domain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLicense, readCredit } from '../src/lib/commons-license';

test('[#311] GFDL is not public domain', () => {
  assert.equal(classifyLicense('GFDL'), 'other');
  assert.equal(classifyLicense('CC0'), 'public-domain');
  const credit = readCredit({ LicenseShortName: { value: 'GFDL' } }, 'https://commons.wikimedia.org/wiki/File:x.png');
  assert.equal(credit.licenseClass, 'other');
  assert.ok(credit.warnings.some(warning => /人工确认/.test(warning)));
  assert.ok(credit.warnings.some(warning => /署名/.test(warning)), '缺少署名时同样提示');
});
