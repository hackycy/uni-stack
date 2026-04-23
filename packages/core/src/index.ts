import MagicString from 'magic-string'

export * from './compare'

export { findConfigFile, parse } from './config-parser'

export * from './file'

export {
  CommentArray,
  type CommentJSONValue,
  type CommentObject,
  assign as jsoncAssign,
  parse as jsoncParse,
  stringify as jsoncStringify,
} from 'comment-json'

export { MagicString }
