"""Bounded PDF worker. No file paths or secrets accepted; bytes in, UTF-8 text out."""
import io
import sys


def main():
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (3, 3))
    from pypdf import PdfReader
    data = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise ValueError('size')
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted or len(reader.pages) > 12:
        raise ValueError('unsupported PDF')
    text = ''
    for page in reader.pages:
        contents = page.get_contents()
        if contents is not None and len(contents.get_data()) > 2 * 1024 * 1024:
            raise ValueError('page size')
        text += (page.extract_text() or '') + '\n'
        if len(text) >= 12000:
            break
    sys.stdout.buffer.write(text[:12000].encode('utf-8'))


if __name__ == '__main__':
    main()
