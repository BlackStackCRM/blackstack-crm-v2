const bcrypt = require('bcryptjs');

class PasswordService {
  static async hash(password) {
    const salt = await bcrypt.genSalt(12);
    return bcrypt.hash(password, salt);
  }

  static async verify(password, hash) {
    return bcrypt.compare(password, hash);
  }
}

module.exports = { PasswordService };
