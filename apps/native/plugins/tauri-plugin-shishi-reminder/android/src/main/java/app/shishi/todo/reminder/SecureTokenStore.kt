package app.shishi.todo.reminder

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import java.security.MessageDigest
import java.security.UnrecoverableKeyException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Encrypted secure-token storage.
 *
 * Each logical token gets a dedicated AES-256 key in AndroidKeyStore. The
 * SharedPreferences file contains only a hashed preference key and a JSON value
 * with the per-record key alias, GCM IV and ciphertext. Token plaintext is never
 * written to SharedPreferences, SQLite or the WebView storage.
 */
internal object SecureTokenStore {
  private const val PREFS_NAME = "shishi_secure_tokens"
  private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
  private const val KEY_ALIAS_PREFIX = "shishi_secure_token_"
  private const val TRANSFORMATION = "AES/GCM/NoPadding"
  private const val GCM_TAG_BITS = 128
  private const val MAX_KEY_LENGTH = 256
  private const val HEX = "0123456789abcdef"

  @Synchronized
  fun get(context: Context, key: String): String? {
    validateKey(key)
    val raw = preferences(context).getString(preferenceKey(key), null) ?: return null
    val payload = try {
      JSONObject(raw)
    } catch (error: Exception) {
      throw IllegalStateException("安全令牌记录损坏", error)
    }
    val alias = payload.optString("keyAlias")
    if (alias.isEmpty()) {
      throw IllegalStateException("安全令牌记录缺少 key alias")
    }
    val iv = decode(payload.optString("iv"), "iv")
    val ciphertext = decode(payload.optString("ciphertext"), "ciphertext")
    val secretKey = loadKey(alias)
      ?: throw IllegalStateException("Android Keystore 中找不到该令牌密钥")

    return try {
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_BITS, iv))
      String(cipher.doFinal(ciphertext), Charsets.UTF_8)
    } catch (error: Exception) {
      throw IllegalStateException("无法解密安全令牌", error)
    }
  }

  @Synchronized
  fun set(context: Context, key: String, value: String) {
    validateKey(key)
    val alias = keyAlias(key)
    val secretKey = getOrCreateKey(alias)
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, secretKey)
    val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    val payload = JSONObject()
      .put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
      .put("ciphertext", Base64.encodeToString(ciphertext, Base64.NO_WRAP))
      .put("keyAlias", alias)
    val committed = preferences(context)
      .edit()
      .putString(preferenceKey(key), payload.toString())
      .commit()
    if (!committed) {
      throw IllegalStateException("无法写入安全令牌存储")
    }
  }

  /**
   * Removes the Keychain-equivalent key material and ciphertext. Calling this
   * for an unknown key is a successful no-op.
   */
  @Synchronized
  fun remove(context: Context, key: String) {
    validateKey(key)
    val prefs = preferences(context)
    val stored = prefs.getString(preferenceKey(key), null)
    val alias = stored
      ?.let { raw ->
        try {
          JSONObject(raw).optString("keyAlias").ifEmpty { keyAlias(key) }
        } catch (_: Exception) {
          keyAlias(key)
        }
      }
      ?: keyAlias(key)

    deleteKey(alias)
    val committed = prefs.edit().remove(preferenceKey(key)).commit()
    if (!committed) {
      throw IllegalStateException("无法清除安全令牌记录")
    }
  }

  private fun preferences(context: Context) =
    context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  private fun preferenceKey(key: String): String = "token_" + digest(key)

  private fun keyAlias(key: String): String = KEY_ALIAS_PREFIX + digest(key).take(32)

  private fun digest(value: String): String {
    val bytes = MessageDigest.getInstance("SHA-256")
      .digest(value.toByteArray(Charsets.UTF_8))
    val result = StringBuilder(bytes.size * 2)
    for (byte in bytes) {
      val unsigned = byte.toInt() and 0xff
      result.append(HEX[unsigned ushr 4])
      result.append(HEX[unsigned and 0x0f])
    }
    return result.toString()
  }

  private fun androidKeyStore(): KeyStore =
    KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }

  private fun getOrCreateKey(alias: String): SecretKey {
    val keyStore = androidKeyStore()
    try {
      val existing = keyStore.getKey(alias, null) as? SecretKey
      if (existing != null) {
        return existing
      }
    } catch (_: UnrecoverableKeyException) {
      keyStore.deleteEntry(alias)
    }
    if (keyStore.containsAlias(alias)) {
      throw IllegalStateException("Android Keystore 令牌别名不可用")
    }

    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER)
    generator.init(
      KeyGenParameterSpec.Builder(
        alias,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return generator.generateKey()
  }

  private fun loadKey(alias: String): SecretKey? =
    try {
      androidKeyStore().getKey(alias, null) as? SecretKey
    } catch (error: UnrecoverableKeyException) {
      throw IllegalStateException("Android Keystore 令牌密钥不可用", error)
    }

  private fun deleteKey(alias: String) {
    val keyStore = androidKeyStore()
    if (keyStore.containsAlias(alias)) {
      keyStore.deleteEntry(alias)
    }
  }

  private fun decode(value: String, label: String): ByteArray {
    if (value.isEmpty()) {
      throw IllegalStateException("安全令牌记录缺少 $label")
    }
    return Base64.decode(value, Base64.NO_WRAP)
  }

  private fun validateKey(key: String) {
    if (key.trim().isEmpty() || key.length > MAX_KEY_LENGTH) {
      throw IllegalArgumentException("secure token key 无效")
    }
    if (key.any { character ->
        character.code > 0x7f ||
          (!character.isLetterOrDigit() && "._:-".indexOf(character) < 0)
      }
    ) {
      throw IllegalArgumentException("secure token key 只允许 ASCII 字母、数字和 . _ : -")
    }
  }
}
