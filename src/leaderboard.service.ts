import { Injectable, OnDestroy } from '@angular/core';
import { Store } from '@ngrx/store';
import { interval, Subscription } from 'rxjs';
import { HttpClient } from '@angular/common/http';

const LEADERBOARD_URL = 'https://study-war-leaderboard.onrender.com';
const UPDATE_INTERVAL_MS = 30000;

@Injectable({ providedIn: 'root' })
export class LeaderboardService implements OnDestroy {
  private _sub?: Subscription;
  private _username = '';

  constructor(private _store: Store, private _http: HttpClient) {}

  init(username: string) {
    this._username = username;
    this._sendUpdate();
    this._sub = interval(UPDATE_INTERVAL_MS).subscribe(() => this._sendUpdate());
  }

  private _sendUpdate() {
    const state = (window as any).__SP_STATE__;
    if (!state) return;

    const tasks = state.tasks?.entities || {};
    let totalMs = 0;

    // Daily breakdown: { "YYYY-MM-DD": totalMs }
    const dailyMs: Record<string, number> = {};
    let isActive = false;

    for (const task of Object.values(tasks) as any[]) {
      if (!task) continue;

      // Total time
      const taskTotal = task.timeSpent || 0;
      totalMs += taskTotal;

      // Active check
      if (task.isActive) isActive = true;

      // Daily breakdown from timeSpentOnDay
      const timeSpentOnDay = task.timeSpentOnDay || {};
      for (const [dateKey, ms] of Object.entries(timeSpentOnDay) as [string, number][]) {
        if (!dailyMs[dateKey]) dailyMs[dateKey] = 0;
        dailyMs[dateKey] += ms;
      }
    }

    this._http.post(`${LEADERBOARD_URL}/api/update`, {
      username: this._username,
      timeSpentMs: totalMs,
      isActive,
      taskBreakdown: dailyMs
    }).subscribe({ error: (e: any) => console.warn('[Leaderboard] update failed', e) });
  }

  ngOnDestroy() {
    this._sub?.unsubscribe();
  }
}
