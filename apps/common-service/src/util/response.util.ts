export class ResponseUtil<T> {
  data: T;
  message: string;
  code: number;
  constructor(data: T, message: string, code: number) {
    this.data = data;
    this.message = message;
    this.code = code;
  }

  static success<T>(data: T, message = 'ok', code = 200) {
    return new ResponseUtil(data, message, code);
  }

  static error(message = '服务器错误无可奉告', code = 500) {
    return new ResponseUtil<null>(null, message, code);
  }
}
