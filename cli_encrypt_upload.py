"""
CLI暗号化アップロードスクリプト
ブラウザ側と同じ AES-256-GCM + PBKDF2 形式で暗号化してGASにアップロードする
"""
import sys
import os
import json
import hashlib
import base64
import urllib.request
import urllib.parse
from Crypto.Cipher import AES

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

if __name__ == '__main__':
    if len(sys.argv) < 5:
        print("Usage: py cli_encrypt_upload.py <GAS_URL> <AUTH> <FILE_PATH> <UPLOAD_PATH> [ENC_KEY]")
        sys.exit(1)

    gas_url = sys.argv[1]
    auth = sys.argv[2]
    file_path = sys.argv[3]
    upload_path = sys.argv[4]
    enc_key = sys.argv[5] if len(sys.argv) > 5 else None

    print(f"アップロード: {upload_path}")
    if enc_key:
        print(f"  暗号化: 有効")

    result = upload(gas_url, auth, file_path, upload_path, enc_key)
    print(f"  結果: {result['status']}")
    if result['status'] != 'success':
        print(f"  エラー: {result.get('message', '')}")
        sys.exit(1)
    print("  完了!")
