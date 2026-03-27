import type { ReactNode } from 'react';
import styles from './Layout.module.scss';

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.layout}>
      <header className={styles.header}>
        <h1 className={styles.title}>Cooking Scheduler</h1>
        <p className={styles.subtitle}>
          Coordinate multiple recipes into one perfect meal
        </p>
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
