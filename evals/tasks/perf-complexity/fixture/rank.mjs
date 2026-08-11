// Given a list of events, find for each event the number of earlier events
// whose score is strictly lower. The public contract is countLowerBefore.
//
// The current implementation is correct but quadratic, which is too slow for
// the sizes this is used with.
export function countLowerBefore(events) {
  return events.map((event, index) => {
    let count = 0;
    for (let earlier = 0; earlier < index; earlier += 1) {
      if (events[earlier].score < event.score) count += 1;
    }
    return count;
  });
}
