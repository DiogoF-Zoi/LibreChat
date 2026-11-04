import { formatContentDisposition } from '../disposition';

/** Printable ASCII only: no control characters that could split or inject a header. */
const HEADER_SAFE = /^[\x20-\x7e]+$/;

describe('formatContentDisposition', () => {
  it('pairs an ASCII fallback with the exact UTF-8 name', () => {
    expect(formatContentDisposition('report.pdf')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  it('encodes non-ASCII names per RFC 5987', () => {
    const value = formatContentDisposition('relatório 日本.xlsx');

    expect(value).toMatch(HEADER_SAFE);
    expect(value).toContain(`filename*=UTF-8''relat%C3%B3rio%20%E6%97%A5%E6%9C%AC.xlsx`);
    expect(value).toContain('filename="relato_rio __.xlsx"');
  });

  it('cannot break out of the quoted name or inject a header', () => {
    const value = formatContentDisposition('a";\\\r\nSet-Cookie: x=1\u0000\u007f.pdf');

    expect(value).toMatch(HEADER_SAFE);
    expect(value.startsWith('attachment; filename="a_;__')).toBe(true);
    expect(value.split('"')).toHaveLength(3);
    expect(value).toContain(`filename*=UTF-8''a%22%3B%5C%0D%0ASet-Cookie%3A%20x%3D1%00%7F.pdf`);
  });

  it.each([undefined, null, ''])('falls back to "download" for %p', (name) => {
    expect(formatContentDisposition(name)).toBe(
      `attachment; filename="download"; filename*=UTF-8''download`,
    );
  });

  it('replaces lone surrogates instead of throwing', () => {
    expect(() => formatContentDisposition('bad\uD800.pdf')).not.toThrow();
    expect(formatContentDisposition('bad\uD800.pdf')).toContain(`UTF-8''bad%EF%BF%BD.pdf`);
  });

  it('percent-encodes RFC 5987 reserved characters', () => {
    expect(formatContentDisposition("it's (1)*.txt")).toContain(`UTF-8''it%27s%20%281%29%2A.txt`);
  });

  it('supports inline disposition', () => {
    expect(formatContentDisposition('a.png', 'inline').startsWith('inline; ')).toBe(true);
  });
});
