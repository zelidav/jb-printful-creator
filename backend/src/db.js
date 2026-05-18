import { Firestore } from '@google-cloud/firestore';

const db = new Firestore({ projectId: process.env.GCP_PROJECT || 'printful-manager' });

export const Users = db.collection('jb_users');
export const Sessions = db.collection('jb_sessions');
export const MagicLinks = db.collection('jb_magic_links');
export const Orders = db.collection('jb_orders');
export const Activity = db.collection('jb_activity');

export async function logActivity(type, data = {}) {
  try {
    await Activity.add({ type, data, ts: Date.now() });
  } catch (e) { console.error('activity log failed:', e); }
}

export { db };
