// import { Contact } from '../types/index';
import { store, dispatch } from '../stores';
import * as firebase from 'firebase';
import { checkCondition, getValues, prettyJson } from '../globals';
import {
  BooleanIndexer,
  MatchInfo,
  GameInfo,
  MatchState,
  PieceState,
  IdIndexer,
  UserIdsAndPhoneNumbers,
  SignalEntry,
  PhoneNumberToContact
} from '../types';

// All interactions with firebase must be in this module.
export namespace ourFirebase {
  // We're using redux, so all state must be stored in the store.
  // I.e., we can't have any state/variables/etc that is used externally.
  let calledFunctions: BooleanIndexer = {};
  function checkFunctionIsCalledOnce(functionName: string) {
    checkCondition('checkFunctionIsCalledOnce', !calledFunctions[functionName]);
    calledFunctions[functionName] = true;
  }

  // Call init exactly once to connect to firebase.
  export function init(testConfig?: Object) {
    checkFunctionIsCalledOnce('init');
    // Initialize Firebase
    let config = {
      apiKey: 'AIzaSyDA5tCzxNzykHgaSv1640GanShQze3UK-M',
      authDomain: 'universalgamemaker.firebaseapp.com',
      databaseURL: 'https://universalgamemaker.firebaseio.com',
      projectId: 'universalgamemaker',
      storageBucket: 'universalgamemaker.appspot.com',
      messagingSenderId: '144595629077'
    };
    firebase.initializeApp(testConfig ? testConfig : config);
  }

  // See https://firebase.google.com/docs/auth/web/phone-auth
  let myCountryCode = '';
  export function signInWithPhoneNumber(
    phoneNumber: string,
    countryCode: string,
    applicationVerifier: firebase.auth.ApplicationVerifier
  ): Promise<any> {
    checkFunctionIsCalledOnce('signInWithPhoneNumber');
    myCountryCode = countryCode;
    // Eventually call writeUser.
    // TODO: set recaptcha
    return firebase
      .auth()
      .signInWithPhoneNumber(phoneNumber, applicationVerifier);
  }

  function getTimestamp(): number {
    return <number>firebase.database.ServerValue.TIMESTAMP;
  }

  export function writeUser(overridePhoneNumberForTest: string = '') {
    checkFunctionIsCalledOnce('writeUser');
    const user = assertLoggedIn();
    const phoneNumber = user.phoneNumber
      ? user.phoneNumber
      : overridePhoneNumberForTest;
    const userFbr: fbr.PrivateFields = {
      createdOn: getTimestamp(), // It's actually "last logged in on timestamp"
      fcmTokens: {},
      contacts: {},
      phoneNumber: phoneNumber,
      countryCode: myCountryCode
    };
    // I don't want to update these.
    delete userFbr.fcmTokens;
    delete userFbr.contacts;
    refUpdate(
      getRef(`/gamePortal/gamePortalUsers/${user.uid}/privateFields`),
      userFbr
    );

    const phoneNumberFbr: fbr.PhoneNumber = {
      userId: user.uid,
      timestamp: getTimestamp()
    };
    if (phoneNumber) {
      refSet(
        getRef(`/gamePortal/phoneNumberToUserId/${phoneNumber}`),
        phoneNumberFbr
      );
    }

    // call all checkFunctionIsCalledOnce.
    listenToMyMatchesList();
    // TODO: put data fetchGamesList();
    listenToSignals();
  }

  // Eventually dispatches the action setGamesList.
  export function fetchGamesList() {
    checkFunctionIsCalledOnce('fetchGamesList');
    assertLoggedIn();
    getRef('/gamePortal/gamesInfoAndSpec/gameInfos').once('value', snapshot => {
      const gameInfos: fbr.GameInfos = snapshot.val();
      if (!gameInfos) {
        throw new Error('no games!');
      }
      const gameInfosKeys = Object.keys(gameInfos);
      const gameList: GameInfo[] = gameInfosKeys.map(gameInfosKey => {
        const gameInfoFbr = gameInfos[gameInfosKey];
        const screenShootImage = gameInfoFbr.screenShootImage;
        const gameInfo: GameInfo = {
          gameSpecId: gameInfoFbr.gameSpecId,
          gameName: gameInfoFbr.gameName,
          screenShoot: {
            imageId: gameInfoFbr.screenShootImageId,
            height: screenShootImage.height,
            width: screenShootImage.width,
            isBoardImage: screenShootImage.isBoardImage,
            downloadURL: screenShootImage.downloadURL
          }
        };
        return gameInfo;
      });
      dispatch({ setGamesList: gameList });
    });
  }

  // Eventually dispatches the action updateGameSpecs.
  // TODO: export function fetchGameSpec(game: GameInfo) {}

  // Eventually dispatches the action setMatchesList
  // every time this field is updated:
  //  /gamePortal/gamePortalUsers/$myUserId/privateButAddable/matchMemberships
  function listenToMyMatchesList() {
    checkFunctionIsCalledOnce('listenToMyMatchesList');
    getMatchMembershipsRef().on('value', snap => {
      getMatchMemberships(snap ? snap.val() : {});
    });
  }

  function getMatchMembershipsRef(userId?: string) {
    const uid = userId ? userId : getUserId();
    return getRef(
      `/gamePortal/gamePortalUsers/${uid}/privateButAddable/matchMemberships`
    );
  }

  const listeningToMatchIds: string[] = [];
  const receivedMatches: IdIndexer<MatchInfo> = {};

  function getMatchMemberships(matchMemberships: fbr.MatchMemberships) {
    if (!matchMemberships) {
      return;
    }
    const matchIds = Object.keys(matchMemberships);
    const newMatchIds: string[] = matchIds.filter(
      matchId => listeningToMatchIds.indexOf(matchId) === -1
    );
    for (let matchId of newMatchIds) {
      listenToMatch(matchId);
    }
  }

  function listenToMatch(matchId: string) {
    checkCondition(
      'listeningToMatchIds',
      listeningToMatchIds.indexOf(matchId) === -1
    );
    listeningToMatchIds.push(matchId);
    // let matchInfo = {};
    return getRef('/gamePortal/matches/' + matchId).on('value', snap => {
      if (!snap) {
        return;
      }
      const matchFb: fbr.Match = snap.val();
      if (!matchFb) {
        return;
      }
      const gameSpecId = matchFb.gameSpecId;
      const game: GameInfo | undefined = store
        .getState()
        .gamesList.find(gameInList => gameInList.gameSpecId === gameSpecId);
      checkCondition('missing gameSpecId for match', game);
      const newMatchStates = convertPiecesStateToMatchState(matchFb.pieces);
      const participants = matchFb.participants;
      // Sort by participant's index (ascending participantIndex order)
      const participantsUserIds = Object.keys(participants).sort(
        (uid1, uid2) =>
          participants[uid1].participantIndex -
          participants[uid2].participantIndex
      );

      const match: MatchInfo = {
        matchId: matchId,
        game: game!,
        participantsUserIds: participantsUserIds,
        lastUpdatedOn: matchFb.lastUpdatedOn,
        matchState: newMatchStates
      };
      receivedMatches[matchId] = match;
      const matches = getValues(receivedMatches);
      if (matches.length === listeningToMatchIds.length) {
        // We got all the matches.
        // Sort by lastUpdatedOn (descending lastUpdatedOn order).
        matches.sort((a, b) => b.lastUpdatedOn - a.lastUpdatedOn);
        dispatch({ setMatchesList: matches });
      }
    });
  }

  export function createMatch(
    game: GameInfo,
    initialState: MatchState
  ): MatchInfo {
    const uid = getUserId();
    const matchRef = getRef('/gamePortal/matches').push();
    const matchId = matchRef.key!;
    const participants: fbr.Participants = {};
    participants[uid] = {
      participantIndex: 0,
      pingOpponents: getTimestamp()
    };
    const newFBMatch: fbr.Match = {
      gameSpecId: game.gameSpecId,
      participants: participants,
      createdOn: getTimestamp(),
      lastUpdatedOn: getTimestamp(),
      pieces: convertMatchStateToPiecesState(initialState)
    };
    refSet(matchRef, newFBMatch);
    addMatchMembership(uid, matchId);

    const newMatch: MatchInfo = {
      matchId: matchId,
      game: game,
      participantsUserIds: [uid],
      lastUpdatedOn: newFBMatch.lastUpdatedOn,
      matchState: initialState
    };
    return newMatch;
  }

  function addMatchMembership(toUserId: string, matchId: string) {
    const matchMembership: fbr.MatchMembership = {
      addedByUid: getUserId(),
      timestamp: getTimestamp()
    };
    const matchMemberships: fbr.MatchMemberships = {
      [matchId]: matchMembership
    };
    refUpdate(getMatchMembershipsRef(toUserId), matchMemberships);
  }

  export function addParticipant(match: MatchInfo, userId: string) {
    checkCondition(
      'addParticipant',
      match.participantsUserIds.indexOf(userId) === -1
    );
    const matchId = match.matchId;
    const participantNumber = match.participantsUserIds.length;
    const participantUserObj: fbr.ParticipantUser = {
      participantIndex: participantNumber,
      pingOpponents: getTimestamp()
    };
    refSet(
      getRef(`/gamePortal/matches/${matchId}/participants/${userId}`),
      participantUserObj
    );
    addMatchMembership(userId, matchId);
  }

  export function updateMatchState(match: MatchInfo, matchState: MatchState) {
    refUpdate(
      getRef(`/gamePortal/matches/${match.matchId}/pieces`),
      convertMatchStateToPiecesState(matchState)
    );
  }

  function convertPiecesStateToMatchState(
    piecesState: fbr.PiecesState
  ): MatchState {
    const newMatchStates: MatchState = {};
    const tempPieces = piecesState ? piecesState : {};
    Object.keys(tempPieces).forEach(tempPieceKey => {
      let newMatchState: PieceState;
      newMatchState = {
        x: tempPieces[tempPieceKey].currentState.x,
        y: tempPieces[tempPieceKey].currentState.y,
        zDepth: tempPieces[tempPieceKey].currentState.zDepth,
        cardVisibility: tempPieces[tempPieceKey].currentState.cardVisibility,
        currentImageIndex:
          tempPieces[tempPieceKey].currentState.currentImageIndex
      };
      newMatchStates[tempPieceKey] = newMatchState;
    });
    return newMatchStates;
  }

  function convertMatchStateToPiecesState(
    matchState: MatchState
  ): fbr.PiecesState {
    const piecesState: fbr.PiecesState = {};
    for (let pieceIndex of Object.keys(matchState)) {
      const pieceState = matchState[pieceIndex];
      piecesState[pieceIndex] = {
        currentState: {
          x: pieceState.x,
          y: pieceState.y,
          zDepth: pieceState.zDepth,
          currentImageIndex: pieceState.currentImageIndex,
          cardVisibility: pieceState.cardVisibility,
          rotationDegrees: 360,
          drawing: {}
        }
      };
    }
    return piecesState;
  }

  export function pingOpponentsInMatch(match: MatchInfo) {
    const userId = getUserId();
    const matchId = match.matchId;
    refSet(
      getRef(
        `/gamePortal/matches/${matchId}/participants/${userId}/pingOpponents`
      ),
      getTimestamp()
    );
  }

  // Stores my contacts in firebase and eventually dispatches updateUserIdsAndPhoneNumbers.
  export function storeContacts(currentContacts: PhoneNumberToContact) {
    checkFunctionIsCalledOnce('storeContacts');
    const currentPhoneNumbers = Object.keys(currentContacts);
    const state = store.getState();

    // Mapping phone number to userId for those numbers that don't have a userId.
    const phoneNumberToUserId =
      state.userIdsAndPhoneNumbers.phoneNumberToUserId;
    const numbersWithoutUserId = currentPhoneNumbers.filter(
      phoneNumber => phoneNumberToUserId[phoneNumber] === undefined
    );
    mapPhoneNumbersToUserIds(numbersWithoutUserId);

    // TODO: Update firebase with changes to contacts (new contacts or name changed).
    // const oldContacts = store.getState().phoneNumberToContact;

    // TODO: check firebase rules hold:
    // "$contactPhoneNumber" matches(/^[+][0-9]{5,20}$/)
    // "contactName": validateMandatoryString(20),
    dispatch({ updatePhoneNumberToContact: currentContacts });
  }

  function mapPhoneNumbersToUserIds(phoneNumbers: string[]) {
    // TODO: compare with existing contacts in store.
    // TODO: Store contacts in user info + name (so notifications will work).
    const userIdsAndPhoneNumbers: UserIdsAndPhoneNumbers = {
      phoneNumberToUserId: {},
      userIdToPhoneNumber: {}
    };
    const promises: Promise<void>[] = [];
    phoneNumbers.forEach((phoneNumber: string) => {
      promises.push(getPhoneNumberDetail(userIdsAndPhoneNumbers, phoneNumber));
    });
    Promise.all(promises).then(() => {
      dispatch({ updateUserIdsAndPhoneNumbers: userIdsAndPhoneNumbers });
    });
  }

  function getPhoneNumberDetail(
    userIdsAndPhoneNumbers: UserIdsAndPhoneNumbers,
    phoneNumber: string
  ): Promise<void> {
    return getRef(`/gamePortal/phoneNumberToUserId/` + phoneNumber)
      .once('value')
      .then(snap => {
        if (!snap) {
          return;
        }
        const phoneNumberFbrObj: fbr.PhoneNumber = snap.val();
        if (!phoneNumberFbrObj) {
          return;
        }
        const userId = phoneNumberFbrObj.userId;
        userIdsAndPhoneNumbers.userIdToPhoneNumber[userId] = phoneNumber;
        userIdsAndPhoneNumbers.phoneNumberToUserId[phoneNumber] = userId;
      });
  }

  // Dispatches setSignals.
  function listenToSignals() {
    checkFunctionIsCalledOnce('listenToSignals');
    const userId = getUserId();
    const ref = getRef(
      `/gamePortal/gamePortalUsers/${userId}/privateButAddable/signals`
    );
    ref.on('value', snap => {
      if (!snap) {
        return;
      }
      const signalsFbr: fbr.Signals = snap.val();
      if (!signalsFbr) {
        return;
      }
      // We start with the old signals and add to them.
      let signals: SignalEntry[] = store.getState().signals;
      let updates: any = {};
      Object.keys(signalsFbr).forEach(entryId => {
        updates[entryId] = null;
        const signalFbr: fbr.SignalEntry = signalsFbr[entryId];
        const signal: SignalEntry = signalFbr;
        signals.push(signal);
      });

      // Deleting the signals we got from firebase.
      refUpdate(ref, updates);

      // filtering old signals.
      const now = new Date().getTime();
      const fiveMinAgo = now - 5 * 60 * 1000;
      signals = signals.filter(signal => fiveMinAgo <= signal.timestamp);

      // Sorting: oldest entries are at the beginning
      signals.sort((signal1, signal2) => signal1.timestamp - signal2.timestamp);

      dispatch({ setSignals: signals });
    });
  }

  export function sendSignal(
    toUserId: string,
    signalType: 'sdp' | 'candidate',
    signalData: string
  ) {
    const userId = getUserId();
    const signalFbr: fbr.SignalEntry = {
      addedByUid: userId,
      timestamp: getTimestamp(),
      signalType: signalType,
      signalData: signalData
    };
    const signalFbrRef = getRef(
      `/gamePortal/gamePortalUsers/${toUserId}/privateButAddable/signals`
    ).push();
    refSet(signalFbrRef, signalFbr);
  }

  export function addFcmToken(fcmToken: string, platform: 'ios' | 'android') {
    // Can be called multiple times if the token is updated.
    const fcmTokenObj: fbr.FcmToken = {
      lastTimeReceived: <any>firebase.database.ServerValue.TIMESTAMP,
      platform: platform
    };
    return refSet(
      getRef(
        `/gamePortal/gamePortalUsers/${getUserId()}/privateFields/fcmTokens/${fcmToken}`
      ),
      fcmTokenObj
    );
  }

  export let allPromisesForTests: Promise<any>[] | null = null;

  function addPromiseForTests(promise: Promise<any>) {
    if (allPromisesForTests) {
      allPromisesForTests.push(promise);
    }
  }

  function refSet(ref: firebase.database.Reference, val: any) {
    addPromiseForTests(ref.set(val, getOnComplete(ref, val)));
  }

  function refUpdate(ref: firebase.database.Reference, val: any) {
    // console.log('refUpdate', ref.toString(), " val=", prettyJson(val));
    addPromiseForTests(ref.update(val, getOnComplete(ref, val)));
  }

  function getOnComplete(ref: firebase.database.Reference, val: any) {
    return (err: Error | null) => {
      // on complete
      if (err) {
        let msg =
          'Failed writing to ref=' +
          ref.toString() +
          ` value=` +
          prettyJson(val);
        console.error(msg);
        throw new Error(msg);
      }
    };
  }

  function assertLoggedIn(): firebase.User {
    const user = currentUser();
    if (!user) {
      throw new Error('You must be logged in');
    }
    return user;
  }

  export function getUserId() {
    return assertLoggedIn().uid;
  }

  function currentUser() {
    return firebase.auth().currentUser;
  }

  function getRef(path: string) {
    return firebase.database().ref(path);
  }
}
