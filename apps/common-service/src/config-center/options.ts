import { IOptions } from '../type';
const options = {} as IOptions;

export function getOptions() {
  return options;
}

export function setOptions(newOptions: IOptions) {
  Object.assign(options, newOptions);
}
