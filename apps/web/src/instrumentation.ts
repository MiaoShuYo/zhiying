/**
 * Clean up partial project data left by a restore process that was force-killed.
 * Restore markers include the owning process id, so an old live server is left alone
 * while a restarted server can safely remove the abandoned project and files.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { cleanupInterruptedRestores } = await import('@/lib/backups');
  await cleanupInterruptedRestores();
}
