/* Cyboros Harness landing — static asset Worker.
 *
 * The site is entirely static; this entrypoint exists so the site can be hosted
 * as a Worker with an assets binding. It serves the built files and nothing
 * else: no API routes, no environment secrets, no dynamic behaviour.
 */
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
