"""
CLI暗号化アップロードスクリプト
ブラウザ側と同じ AES-256-GCM + PBKDF2 形式で暗号化してGASにアップロードする

使い方:
  単体ファイル:
    py cli_encrypt_upload.py <GAS_URL> <AUTH> <FILE_PATH> <UPLOAD_PATH> [ENC_KEY]

  フォルダ一括（.md/.txt のみ、1ファイル200KB上限）:
    py cli_encrypt_upload.py <GAS_URL> <AUTH> <FOLDER_PATH> <UPLOAD_PREFIX> [ENC_KEY]
    例: py cli_encrypt_upload.py URL AUTH ./ピリカ2回目 ピリカ2回目 ENC_KEY
"""
import sys
import os
import json
import hashlib
import base64
import urllib.request
import urllib.parse
from Crypto.Cipher import AES

MAX_FILE_SIZE = 200 * 1024  # 200KB
ALLOWED_EXTENSIONS = {'.md', '.txt'}

def derive_key(passphrase: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac('sha256', passphrase.encode('utf-8'), salt, 100000, dklen=32)

def encrypt(plaintext: str, passphrase: str) -> dict:
    salt = os.urandom(16)
    iv = os.urandom(12)
    key = derive_key(passphrase, salt)

    cipher = AES.new(key, AES.MODE_GCM, nonce=iv)
    ciphertext, tag = cipher.encrypt_and_digest(plaintext.encode('utf-8'))

    # ブラウザ側と同じ形式: ciphertext + tag を結合してbase64
    combined = ciphertext + tag

    return {
        "encrypted": True,
        "v": 1,
        "salt": base64.b64encode(salt).decode('ascii'),
        "iv": base64.b64encode(iv).decode('ascii'),
        "data": base64.b64encode(combined).decode('ascii')
    }

def upload(gas_url: str, auth: str, file_path: str, upload_path: str, enc_key: str = None):
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    if enc_key:
        encrypted = encrypt(content, enc_key)
        body = json.dumps(encrypted).encode('utf-8')
        print(f"  暗号化完了 ({len(content)}文字 -> {len(body)}バイト)")
    else:
        body = content.encode('utf-8')

    params = urllib.parse.urlencode({
        'auth': auth,
        'action': 'cli_upload',
        'path': upload_path
    })
    url = f"{gas_url}?{params}"

    req = urllib.request.Request(url, data=body, method='POST')
    req.add_header('Content-Type', 'text/plain; charset=utf-8')

    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read().decode('utf-8'))

    return result

def collect_text_files(folder_path: str):
    """フォルダ内の .md / .txt ファイルを再帰的に収集する"""
    files = []
    for root, dirs, filenames in os.walk(folder_path):
        for fname in filenames:
            ext = os.path.splitext(fname)[1].lower()
            if ext not in ALLOWED_EXTENSIONS:
                continue
            full_path = os.path.join(root, fname)
            size = os.path.getsize(full_path)
            if size > MAX_FILE_SIZE:
                print(f"  ⚠ スキップ（サイズ超過 {size//1024}KB > {MAX_FILE_SIZE//1024}KB）: {fname}")
                continue
            rel_path = os.path.relpath(full_path, folder_path)
            files.append((full_path, rel_path))
    return files

def upload_folder(gas_url: str, auth: str, folder_path: str, upload_prefix: str, enc_key: str = None):
    """フォルダ内のテキストファイルを一括アップロード"""
    files = collect_text_files(folder_path)
    if not files:
        print("アップロード対象のファイルがありません（.md / .txt のみ対象）")
        return

    print(f"対象ファイル: {len(files)}件")
    print(f"アップロード先プレフィックス: {upload_prefix}/")
    print()

    success_count = 0
    fail_count = 0

    for full_path, rel_path in files:
        # パス区切りを / に統一
        upload_path = upload_prefix + '/' + rel_path.replace('\\', '/')
        print(f"  📤 {upload_path}")
        try:
            result = upload(gas_url, auth, full_path, upload_path, enc_key)
            if result['status'] == 'success':
                success_count += 1
                print(f"     ✅ OK")
            else:
                fail_count += 1
                print(f"     ❌ エラー: {result.get('message', '')}")
        except Exception as e:
            fail_count += 1
            print(f"     ❌ 例外: {e}")

    print()
    print(f"完了: 成功 {success_count}件 / 失敗 {fail_count}件")

if __name__ == '__main__':
    if len(sys.argv) < 5:
        print("Usage:")
        print("  単体: py cli_encrypt_upload.py <GAS_URL> <AUTH> <FILE_PATH> <UPLOAD_PATH> [ENC_KEY]")
        print("  フォルダ: py cli_encrypt_upload.py <GAS_URL> <AUTH> <FOLDER_PATH> <UPLOAD_PREFIX> [ENC_KEY]")
        sys.exit(1)

    gas_url = sys.argv[1]
    auth = sys.argv[2]
    file_path = sys.argv[3]
    upload_path = sys.argv[4]
    enc_key = sys.argv[5] if len(sys.argv) > 5 else None

    if os.path.isdir(file_path):
        print(f"📂 フォルダアップロード: {file_path}")
        if enc_key:
            print(f"  暗号化: 有効")
        print(f"  対象拡張子: {', '.join(ALLOWED_EXTENSIONS)}")
        print(f"  サイズ上限: {MAX_FILE_SIZE // 1024}KB/ファイル")
        print()
        upload_folder(gas_url, auth, file_path, upload_path, enc_key)
    else:
        print(f"アップロード: {upload_path}")
        if enc_key:
            print(f"  暗号化: 有効")
        result = upload(gas_url, auth, file_path, upload_path, enc_key)
        print(f"  結果: {result['status']}")
        if result['status'] != 'success':
            print(f"  エラー: {result.get('message', '')}")
            sys.exit(1)
        print("  完了!")
