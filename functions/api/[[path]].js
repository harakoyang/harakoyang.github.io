import { handleRequest } from "../../src/index.js";

// 可选多段路由：/api/me、/api/auth/login/github 都进同一个处理函数。
// 静态资源不经过这里，Pages 会按 public/ 直接返回。
export function onRequest(context) {
  return handleRequest(context.request, context.env, context);
}
