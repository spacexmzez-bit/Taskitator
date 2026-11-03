# Taskitator for Android

Taskitator is a modern focus and task management application built with Kotlin and Jetpack Compose, rewritten from the original Taskitator web app.

## Features

- **Today Queue & Focus:** Prioritized tasks with due dates, P1-P4 priority chips, overdue alerts with bulk reschedule, and status indicators.
- **Hierarchical Subtasks:** Create and manage structured subtask trees under any task.
- **Distraction Dump (Scratchpad):** Quick-capture scratchpad to store distracting thoughts during focus sessions, with one-tap conversion to real tasks.
- **Pomodoro & Focus Timer:** Integrated focus session and break timer with customizable work/break durations and daily break targets.
- **Multi-Selection & Batch Actions:** Batch set priority, edit tags, reschedule due dates, complete, or trash multiple tasks simultaneously.
- **Focus Copilot (Ari):** Intelligent productivity assistant for breaking down tasks, suggesting prioritization strategies, and reviewing progress.
- **Calendar & Projects Views:** Visualize upcoming deadlines in a 14-day schedule and track completion percentages across projects and tags.
- **Productivity Statistics:** Daily completion tracking, focus streaks, priority distributions, and break history logs.
- **Safety & Guardrails:** AI-locked commitments with an intentional 15-minute Emergency Bypass mode.
- **Soft Delete & Trash:** Safely restore tasks or permanently empty trash.
- **Sleep Lock Mode:** Dedicated focus lockout mode to protect quiet hours and recovery.

## Tech Stack

- **UI:** Jetpack Compose with Material Design 3 (M3)
- **Language:** Kotlin
- **Architecture:** MVVM with reactive StateFlows and Repository pattern
- **Design:** Deep Midnight Blue theme with dynamic status pills and custom adaptive launcher icon
