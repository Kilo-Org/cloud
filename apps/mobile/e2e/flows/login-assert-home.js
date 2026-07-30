// Confirms the login helper's already-authenticated branch leaves the app on Home.
module.exports = async function assertHome(ctx) {
  const { h } = ctx;
  await h.tapOn('HOME|Home, tab, 1 of 4');
  await h.assertVisible(/Good (morning|afternoon|evening)/);
};
