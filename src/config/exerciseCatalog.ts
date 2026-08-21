/**
 * Exercise catalog — display names, descriptions, camera recommendations.
 * Used by the exercise selection menu and form guides.
 */

import type { ExerciseFSMConfig } from '../types/index.js';
import {
  squatConfig,
  deadliftConfig,
  pushupConfig,
  bicepCurlConfig,
  shoulderPressConfig,
  lungeConfig,
  lateralRaiseConfig,
  calfRaiseConfig,
  tricepDipConfig,
  jumpingJackConfig,
  wallSitConfig,
  gluteBridgeConfig,
  highKneesConfig,
  sitUpConfig,
  overheadTricepConfig,
  bentOverRowConfig,
  pullUpConfig,
  bandPullUpConfig,
  diamondPushupConfig,
  widePushupConfig,
  plankConfig,
  mountainClimberConfig,
} from './exerciseConfigs.js';

export interface ExerciseCatalogEntry {
  config: ExerciseFSMConfig;
  displayName: string;
  description: string;
  cameraAngle: 'side' | 'front' | 'either';
  muscleGroups: string[];
  steps: string[];
  commonMistakes: string[];
}

export const EXERCISE_CATALOG: ExerciseCatalogEntry[] = [
  {
    config: squatConfig,
    displayName: 'Barbell Squat',
    description: 'Compound lower-body exercise targeting quads, glutes, and hamstrings.',
    cameraAngle: 'either',
    muscleGroups: ['quads', 'glutes', 'hamstrings', 'core'],
    steps: [
      'Stand with feet shoulder-width apart',
      'Brace core, push hips back',
      'Lower until thighs are parallel to floor',
      'Drive through heels to stand back up',
    ],
    commonMistakes: [
      'Knees caving inward (valgus)',
      'Rounding lower back',
      'Heels lifting off floor',
      'Not reaching parallel depth',
    ],
  },
  {
    config: pushupConfig,
    displayName: 'Push-Up',
    description: 'Bodyweight upper-body push exercise for chest, shoulders, and triceps.',
    cameraAngle: 'side',
    muscleGroups: ['chest', 'shoulders', 'triceps', 'core'],
    steps: [
      'Start in plank position, hands under shoulders',
      'Lower chest toward floor by bending elbows',
      'Keep body in a straight line (no sagging hips)',
      'Push back up to full arm extension',
    ],
    commonMistakes: [
      'Hips sagging or piking up',
      'Elbows flaring out past 45°',
      'Not going low enough',
      'Head dropping forward',
    ],
  },
  {
    config: bicepCurlConfig,
    displayName: 'Bicep Curl',
    description: 'Isolation exercise for the biceps brachii.',
    cameraAngle: 'front',
    muscleGroups: ['biceps', 'forearms'],
    steps: [
      'Stand with arms straight at sides, palms forward',
      'Curl weights up by bending elbows',
      'Squeeze at the top (hands near shoulders)',
      'Lower slowly back to starting position',
    ],
    commonMistakes: [
      'Swinging torso for momentum',
      'Elbows drifting forward',
      'Incomplete range of motion',
      'Going too fast on the eccentric',
    ],
  },
  {
    config: shoulderPressConfig,
    displayName: 'Shoulder Press',
    description: 'Overhead pressing movement for deltoids and triceps.',
    cameraAngle: 'front',
    muscleGroups: ['shoulders', 'triceps', 'upper chest'],
    steps: [
      'Hold weights at shoulder height, elbows bent',
      'Press weights overhead',
      'Lock out arms at the top',
      'Lower back to shoulder height with control',
    ],
    commonMistakes: [
      'Arching lower back excessively',
      'Asymmetric press (one arm ahead)',
      'Not fully locking out',
      'Flaring elbows too wide',
    ],
  },
  {
    config: lungeConfig,
    displayName: 'Lunge',
    description: 'Unilateral lower-body exercise for quads, glutes, and balance.',
    cameraAngle: 'side',
    muscleGroups: ['quads', 'glutes', 'hamstrings', 'hip flexors'],
    steps: [
      'Stand tall, feet hip-width apart',
      'Step forward with one leg',
      'Lower until front knee is at ~90°',
      'Push off front foot to return to standing',
    ],
    commonMistakes: [
      'Front knee going past toes',
      'Torso leaning too far forward',
      'Back knee not lowering enough',
      'Wobbling / poor balance',
    ],
  },
  {
    config: lateralRaiseConfig,
    displayName: 'Lateral Raise',
    description: 'Isolation exercise for the lateral deltoid head.',
    cameraAngle: 'front',
    muscleGroups: ['shoulders (lateral deltoid)'],
    steps: [
      'Stand with arms at sides, slight elbow bend',
      'Raise arms out to the sides',
      'Stop when arms are parallel to floor (~90°)',
      'Lower slowly back to sides',
    ],
    commonMistakes: [
      'Raising above shoulder height (impingement risk)',
      'Using momentum / shrugging',
      'Bending elbows too much',
      'Leaning torso to one side',
    ],
  },
  {
    config: calfRaiseConfig,
    displayName: 'Calf Raise',
    description: 'Isolation exercise for the gastrocnemius and soleus.',
    cameraAngle: 'side',
    muscleGroups: ['calves (gastrocnemius)', 'soleus'],
    steps: [
      'Stand with feet hip-width apart',
      'Rise up onto your toes',
      'Squeeze at the top for 1 second',
      'Lower heels back to floor with control',
    ],
    commonMistakes: [
      'Bouncing at the bottom',
      'Not getting full height',
      'Bending knees during raise',
      'Going too fast',
    ],
  },
  {
    config: deadliftConfig,
    displayName: 'Deadlift',
    description: 'Compound posterior chain exercise for back, glutes, and hamstrings.',
    cameraAngle: 'side',
    muscleGroups: ['hamstrings', 'glutes', 'back', 'core'],
    steps: [
      'Stand with feet hip-width, bar over mid-foot',
      'Hinge at hips, grip bar outside legs',
      'Brace core, drive through floor',
      'Lock out hips and knees at the top',
    ],
    commonMistakes: [
      'Rounding lower back',
      'Bar drifting away from body',
      'Knees locking out before hips',
      'Hyperextending at the top',
    ],
  },
  {
    config: tricepDipConfig,
    displayName: 'Tricep Dip',
    description: 'Upper-body push exercise targeting triceps and chest.',
    cameraAngle: 'side',
    muscleGroups: ['triceps', 'chest', 'shoulders'],
    steps: [
      'Grip parallel bars or edge of bench behind you',
      'Start with arms fully extended',
      'Lower body by bending elbows to ~90°',
      'Push back up to full arm extension',
    ],
    commonMistakes: [
      'Going too deep (shoulder strain)',
      'Flaring elbows outward',
      'Leaning too far forward',
      'Not fully locking out at top',
    ],
  },
  {
    config: jumpingJackConfig,
    displayName: 'Jumping Jack',
    description: 'Full-body cardio exercise for warming up and endurance.',
    cameraAngle: 'front',
    muscleGroups: ['shoulders', 'calves', 'core', 'cardio'],
    steps: [
      'Stand with feet together, arms at sides',
      'Jump feet apart while raising arms overhead',
      'Land softly with arms above head',
      'Jump feet back together, arms down',
    ],
    commonMistakes: [
      'Not reaching full arm extension',
      'Landing with stiff legs',
      'Arms not going fully overhead',
      'Inconsistent rhythm',
    ],
  },
  {
    config: wallSitConfig,
    displayName: 'Wall Sit',
    description: 'Isometric lower-body hold for quad endurance.',
    cameraAngle: 'side',
    muscleGroups: ['quads', 'glutes', 'core'],
    steps: [
      'Stand with back flat against a wall',
      'Slide down until thighs are parallel to floor',
      'Keep knees at 90° angle',
      'Hold position — thighs should burn',
    ],
    commonMistakes: [
      'Knees going past toes',
      'Not sitting low enough',
      'Back lifting off the wall',
      'Looking down instead of forward',
    ],
  },
  {
    config: gluteBridgeConfig,
    displayName: 'Glute Bridge',
    description: 'Posterior chain isolation for glutes and hamstrings.',
    cameraAngle: 'side',
    muscleGroups: ['glutes', 'hamstrings', 'core'],
    steps: [
      'Lie on back with knees bent, feet flat on floor',
      'Drive hips up by squeezing glutes',
      'Lift until body forms a straight line (shoulders to knees)',
      'Lower hips back down with control',
    ],
    commonMistakes: [
      'Hyperextending the lower back at top',
      'Not squeezing glutes at the top',
      'Feet too far from body',
      'Rushing the movement',
    ],
  },
  {
    config: highKneesConfig,
    displayName: 'High Knees',
    description: 'Cardio drill that targets hip flexors and core.',
    cameraAngle: 'front',
    muscleGroups: ['hip flexors', 'quads', 'core', 'cardio'],
    steps: [
      'Stand tall with feet hip-width apart',
      'Drive one knee up toward chest (hip height)',
      'Quickly switch legs in a running motion',
      'Pump arms opposite to legs',
    ],
    commonMistakes: [
      'Knees not reaching hip height',
      'Leaning back instead of staying tall',
      'Landing flat-footed (should be on balls of feet)',
      'Slowing tempo too much',
    ],
  },
  {
    config: sitUpConfig,
    displayName: 'Sit-Up',
    description: 'Core exercise targeting the rectus abdominis.',
    cameraAngle: 'side',
    muscleGroups: ['abs', 'hip flexors', 'core'],
    steps: [
      'Lie on back with knees bent, feet flat',
      'Cross arms over chest or behind head',
      'Curl torso up toward knees using abs',
      'Lower back down with control',
    ],
    commonMistakes: [
      'Pulling on neck with hands',
      'Using hip flexors instead of abs',
      'Jerking up with momentum',
      'Not controlling the descent',
    ],
  },
  {
    config: overheadTricepConfig,
    displayName: 'Overhead Tricep Extension',
    description: 'Isolation exercise for the long head of the triceps.',
    cameraAngle: 'side',
    muscleGroups: ['triceps'],
    steps: [
      'Hold weight overhead with arms extended',
      'Keep upper arms close to ears',
      'Lower weight behind head by bending elbows',
      'Extend arms back to starting position',
    ],
    commonMistakes: [
      'Elbows flaring out wide',
      'Arching the lower back',
      'Not going through full range of motion',
      'Using momentum to swing weight up',
    ],
  },
  {
    config: bentOverRowConfig,
    displayName: 'Bent-Over Row',
    description: 'Compound back exercise for lats, rhomboids, and biceps.',
    cameraAngle: 'side',
    muscleGroups: ['back', 'biceps', 'rear deltoids'],
    steps: [
      'Hinge forward at hips, back flat, slight knee bend',
      'Let arms hang straight down with weight',
      'Pull elbows back, squeezing shoulder blades',
      'Lower weight back to hanging position',
    ],
    commonMistakes: [
      'Rounding the upper back',
      'Using momentum to jerk weight up',
      'Not pulling elbows far enough back',
      'Standing too upright',
    ],
  },
  {
    config: pullUpConfig,
    displayName: 'Pull-Up',
    description: 'Upper-body compound pull for lats, biceps, and grip strength.',
    cameraAngle: 'front',
    muscleGroups: ['back', 'biceps', 'forearms'],
    steps: [
      'Grip bar with hands shoulder-width apart (overhand)',
      'Hang with arms fully extended, core engaged',
      'Pull body up until chin clears the bar',
      'Lower with control back to full arm extension',
    ],
    commonMistakes: [
      'Kipping or swinging for momentum',
      'Not going to full extension at bottom',
      'Chin not clearing the bar at top',
      'Flaring elbows too wide',
    ],
  },
  {
    config: bandPullUpConfig,
    displayName: 'Band-Assisted Pull-Up',
    description: 'Pull-up with elastic band support for building strength progressively.',
    cameraAngle: 'front',
    muscleGroups: ['back', 'biceps', 'forearms'],
    steps: [
      'Loop band over bar, step one foot into band',
      'Grip bar shoulder-width, hang with band supporting',
      'Pull up until chin clears the bar',
      'Lower slowly — let band assist at the bottom',
    ],
    commonMistakes: [
      'Relying too much on the band (bouncing)',
      'Not controlling the descent',
      'Chin not reaching bar height',
      'Asymmetric pull (one arm dominant)',
    ],
  },
  {
    config: diamondPushupConfig,
    displayName: 'Diamond Push-Up',
    description: 'Close-grip push-up variation emphasizing inner chest and triceps.',
    cameraAngle: 'side',
    muscleGroups: ['chest', 'triceps', 'core'],
    steps: [
      'Start in plank with hands together forming a diamond shape',
      'Keep elbows close to your body',
      'Lower chest toward your hands',
      'Push back up to full extension',
    ],
    commonMistakes: [
      'Elbows flaring out wide',
      'Hips sagging or piking',
      'Hands too far apart (not diamond)',
      'Not going low enough',
    ],
  },
  {
    config: widePushupConfig,
    displayName: 'Wide Push-Up',
    description: 'Wide-grip push-up variation emphasizing outer chest and shoulders.',
    cameraAngle: 'side',
    muscleGroups: ['chest', 'shoulders', 'core'],
    steps: [
      'Start in plank with hands wider than shoulder-width',
      'Lower chest toward the floor',
      'Keep core tight, body in a straight line',
      'Push back up to starting position',
    ],
    commonMistakes: [
      'Hands not wide enough',
      'Sagging or piking hips',
      'Flaring elbows past 90°',
      'Partial range of motion',
    ],
  },
  {
    config: plankConfig,
    displayName: 'Plank',
    description: 'Isometric core hold for deep stabilizer endurance. (Time-based)',
    cameraAngle: 'side',
    muscleGroups: ['core', 'shoulders', 'glutes'],
    steps: [
      'Start on forearms and toes, body in a straight line',
      'Engage core — pull belly button toward spine',
      'Keep hips level (no sagging or piking)',
      'Hold position — breathe steadily',
    ],
    commonMistakes: [
      'Hips sagging toward the floor',
      'Hips piking up too high',
      'Looking up (straining neck)',
      'Holding breath',
    ],
  },
  {
    config: mountainClimberConfig,
    displayName: 'Mountain Climber',
    description: 'Dynamic core + cardio exercise in plank position.',
    cameraAngle: 'side',
    muscleGroups: ['core', 'hip flexors', 'shoulders', 'cardio'],
    steps: [
      'Start in high plank position, arms straight',
      'Drive one knee toward chest rapidly',
      'Switch legs in a running motion',
      'Keep hips low and core engaged throughout',
    ],
    commonMistakes: [
      'Hips bouncing up too high',
      'Not driving knees far enough forward',
      'Hands shifting position',
      'Losing plank alignment',
    ],
  },
];

/** Quick lookup by exercise name */
export function getExerciseByName(name: string): ExerciseCatalogEntry | undefined {
  return EXERCISE_CATALOG.find((e) => e.config.exerciseName === name);
}

/** Group exercises by their primary muscle group for menu display. */
export function getExercisesByMuscleGroup(): Record<string, ExerciseCatalogEntry[]> {
  const groups: Record<string, ExerciseCatalogEntry[]> = {};
  
  const muscleGroupMap: Record<string, string> = {
    'quads': 'Legs',
    'glutes': 'Legs',
    'hamstrings': 'Legs',
    'calves (gastrocnemius)': 'Legs',
    'soleus': 'Legs',
    'hip flexors': 'Legs',
    'chest': 'Chest',
    'upper chest': 'Chest',
    'shoulders': 'Shoulders',
    'shoulders (lateral deltoid)': 'Shoulders',
    'rear deltoids': 'Back',
    'triceps': 'Arms',
    'biceps': 'Arms',
    'forearms': 'Arms',
    'back': 'Back',
    'core': 'Core',
    'abs': 'Core',
    'cardio': 'Cardio',
  };

  for (const entry of EXERCISE_CATALOG) {
    // Use the first muscle group's mapped category
    const primaryMuscle = entry.muscleGroups[0] ?? 'Other';
    const group = muscleGroupMap[primaryMuscle] ?? 'Other';
    
    if (groups[group] === undefined) {
      groups[group] = [];
    }
    // Avoid duplicates if exercise maps to same group
    if (!groups[group].some(e => e.config.exerciseName === entry.config.exerciseName)) {
      groups[group].push(entry);
    }
  }

  return groups;
}
