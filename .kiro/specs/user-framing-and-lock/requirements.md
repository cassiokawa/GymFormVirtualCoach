# Requirements Document

## Introduction

This feature adds a pre-tracking phase to the CV Fitness & Form Assistant that guides users into the correct camera frame position, suggests the starting pose for the selected exercise, and implements a confidence-based lock mechanism before the RepCounter FSM begins tracking. The goal is to reduce false-positive rep counting, improve pose detection accuracy by ensuring full-body visibility, and provide a smoother onboarding experience before each set.

## Glossary

- **Framing_Guide**: The overlay component that renders a silhouette or bounding-box guide on the canvas to show the user where to stand relative to the camera.
- **Position_Advisor**: The component that compares the user's current pose to the exercise's expected starting position and provides directional correction cues.
- **Pose_Lock**: The gating mechanism that requires high-confidence, full-body detection for a sustained number of consecutive frames before transitioning to active rep tracking.
- **Lock_Threshold**: The minimum per-keypoint visibility confidence score required for a keypoint to be considered "detected" by the Pose_Lock.
- **Lock_Duration**: The number of consecutive frames that must satisfy all lock conditions before the system transitions to active tracking.
- **Framing_Score**: A normalised value [0, 1] representing how well the user's body fits within the ideal framing zone.
- **Starting_Position_Score**: A normalised value [0, 1] representing how closely the user's current joint angles match the exercise's expected starting angles.
- **Active_Tracking**: The state in which the RepCounter FSM processes frames for rep counting and form evaluation.

## Requirements

### Requirement 1: Framing Guide Overlay

**User Story:** As a user, I want to see a visual guide on the camera feed showing me where to stand, so that my full body is visible and detection quality is maximised.

#### Acceptance Criteria

1. WHEN the camera feed is active and Active_Tracking has not begun, THE Framing_Guide SHALL render a semi-transparent body silhouette overlay centred in the canvas indicating the target standing zone.
2. WHEN the user's detected bounding box falls within the target framing zone, THE Framing_Guide SHALL change the overlay colour from red to green to indicate correct positioning.
3. WHEN fewer than 25 of the 33 keypoints have confidence above 0.5, THE Framing_Guide SHALL display a text prompt instructing the user to step back or adjust position.
4. THE Framing_Guide SHALL compute a Framing_Score by calculating the ratio of visible keypoints (confidence >= 0.5) to total keypoints (33) and the overlap between the user bounding box and the target zone.
5. IF the camera feed is lost while the Framing_Guide is active, THEN THE Framing_Guide SHALL display a "Camera Lost" message and halt rendering until the feed resumes.

### Requirement 2: Starting Position Suggestion

**User Story:** As a user, I want the system to show me the correct starting position for my exercise before tracking begins, so that I start each set with proper form.

#### Acceptance Criteria

1. WHEN an exercise is selected and the Framing_Score exceeds 0.7, THE Position_Advisor SHALL compare the user's current joint angles to the exercise config's startThreshold and display per-joint directional cues (e.g., "Straighten knees", "Stand taller").
2. WHEN all tracked joints in the exercise config are within the startThreshold range, THE Position_Advisor SHALL display a "Ready" indicator and set the Starting_Position_Score to 1.0.
3. THE Position_Advisor SHALL update directional cues at a rate no slower than 10 Hz to provide responsive feedback.
4. WHILE the Framing_Score is below 0.7, THE Position_Advisor SHALL suppress starting position feedback and defer to the Framing_Guide's positioning instructions.

### Requirement 3: Confidence-Based Pose Lock

**User Story:** As a user, I want the system to only begin counting reps when it has a reliable, stable detection of my body, so that I do not get false rep counts from transient or partial detections.

#### Acceptance Criteria

1. THE Pose_Lock SHALL require all keypoints listed in the exercise config's joints array to have a confidence score at or above the Lock_Threshold (default: 0.7) for at least Lock_Duration consecutive frames (default: 15 frames) before transitioning to Active_Tracking.
2. WHEN the Pose_Lock conditions are met and the Starting_Position_Score equals 1.0, THE Pose_Lock SHALL transition the system to Active_Tracking and enable the RepCounter FSM.
3. IF during the lock countdown any required keypoint drops below the Lock_Threshold, THEN THE Pose_Lock SHALL reset the consecutive frame counter to zero and remain in the pre-tracking state.
4. WHILE the Pose_Lock is engaged and accumulating consecutive frames, THE Pose_Lock SHALL display a progress indicator showing the percentage of Lock_Duration completed.
5. WHEN Active_Tracking is active and the average confidence of required keypoints drops below 0.5 for 10 consecutive frames, THE Pose_Lock SHALL pause Active_Tracking, suspend the RepCounter FSM, and return to the lock acquisition state.
6. THE Pose_Lock SHALL expose configurable Lock_Threshold and Lock_Duration values through the ExerciseFSMConfig or a dedicated lock configuration object.

### Requirement 4: Integration with Existing Pipeline

**User Story:** As a developer, I want the framing, positioning, and lock components to integrate cleanly with the existing WorkoutSession and demo pipeline, so that the pre-tracking phase is transparent to downstream components.

#### Acceptance Criteria

1. WHEN WorkoutSession.start() is called, THE WorkoutSession SHALL enter the pre-tracking phase (Framing_Guide + Position_Advisor + Pose_Lock) before forwarding frames to the RepCounter and FormEvaluator.
2. WHEN the Pose_Lock transitions to Active_Tracking, THE WorkoutSession SHALL begin forwarding KeypointMessages to RepCounter.update() and FormEvaluator.evaluateFrame() as it does today.
3. THE Framing_Guide, Position_Advisor, and Pose_Lock SHALL consume the same KeypointMessage format produced by the Pose_Detector worker without requiring changes to the worker's output contract.
4. IF the user manually triggers a "Skip Lock" action, THEN THE WorkoutSession SHALL bypass the Pose_Lock countdown and immediately enter Active_Tracking.
