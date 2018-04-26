import { store, dispatch, persistedOldStore } from '../stores';
import * as firebase from 'firebase';
import * as Raven from 'raven-js';
import {
  checkCondition,
  getValues,
  prettyJson,
  objectMap,
  checkNotNull,
  isTests,
  UNKNOWN_NAME,
  getPhoneNumberToUserInfo
} from '../globals';
import {
  BooleanIndexer,
  MatchInfo,
  GameInfo,
  MatchState,
  IdIndexer,
  SignalEntry,
  PhoneNumberToContact,
  Image,
  Element,
  ImageIdToImage,
  ElementIdToElement,
  GameSpec,
  Piece,
  GameSpecIdToGameSpec,
  GameSpecs,
  PieceState,
  AnyIndexer,
  CardVisibility,
  ContactWithUserId,
  UserIdToInfo
} from '../types';
import { Action, checkMatchStateInStore } from '../reducers';

// All interactions with firebase must be in this module.
export namespace ourFirebase {
  // We're using redux, so all state must be stored in the store.
  // I.e., we can't have any state/variables/etc that is used externally.
  let calledFunctions: BooleanIndexer = {};
  function checkFunctionIsCalledOnce(functionName: string) {
    console.log('Calling ', functionName);
    checkCondition('checkFunctionIsCalledOnce', !calledFunctions[functionName]);
    calledFunctions[functionName] = true;
  }

  // Stores my contacts in firebase and eventually dispatches updateUserIdToInfo.
  // storeContacts can be called even before the login finished.
  let contactsToBeStored: PhoneNumberToContact | null = null;
  export function storeContacts(currentContacts: PhoneNumberToContact) {
    checkFunctionIsCalledOnce('storeContacts');
    contactsToBeStored = currentContacts;
    if (currentUser()) {
      storeContactsAfterLogin();
    }
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
    firebase.auth().onAuthStateChanged(user => {
      console.log('onAuthStateChanged: hasUser=', !!user);
      if (user) {
        postLogin();
        if (contactsToBeStored) {
          storeContactsAfterLogin();
        }
      }
    });
  }

  export function getMessaging() {
    return firebase.messaging();
  }

  // See https://firebase.google.com/docs/auth/web/phone-auth
  let myCountryCodeForSignInWithPhoneNumber = '';
  let displayNameForSignIn = '';
  export function signInWithPhoneNumber(
    phoneNumber: string,
    countryCode: string,
    displayName: string,
    applicationVerifier: firebase.auth.ApplicationVerifier
  ): Promise<any> {
    checkFunctionIsCalledOnce('signInWithPhoneNumber');
    checkCondition('countryCode', countryCode.length === 2);
    myCountryCodeForSignInWithPhoneNumber = countryCode;
    displayNameForSignIn = displayName;
    return firebase
      .auth()
      .signInWithPhoneNumber(phoneNumber, applicationVerifier);
  }

  function getTimestamp(): number {
    return <number>firebase.database.ServerValue.TIMESTAMP;
  }

  let phoneNumberForSignInAnonymously: string = '';
  let resolveAfterLoginForTests: (() => void) | null = null;
  export let allPromisesForTests: Promise<any>[] | null = null;
  export function signInAnonymously(
    phoneNumberForTest: string,
    displayName: string
  ) {
    phoneNumberForSignInAnonymously = phoneNumberForTest;
    displayNameForSignIn = displayName;
    addPromiseForTests(firebase.auth().signInAnonymously());
    if (allPromisesForTests) {
      allPromisesForTests.push(
        new Promise(resolve => {
          console.log('Setting resolveAfterLoginForTests');
          resolveAfterLoginForTests = resolve;
        })
      );
    }
  }

  // Function is called after the user is logged in, which can happen either
  // after the login screen (calling signIn* method) or because of cookies.
  function postLogin() {
    checkFunctionIsCalledOnce('postLogin');
    const user = assertLoggedIn();
    const uid = user.uid;
    if (persistedOldStore && uid === persistedOldStore.myUser.myUserId) {
      dispatch({ restoreOldStore: persistedOldStore });
      if (!myCountryCodeForSignInWithPhoneNumber) {
        myCountryCodeForSignInWithPhoneNumber =
          persistedOldStore.myUser.myCountryCode;
      }
      if (!displayNameForSignIn) {
        displayNameForSignIn = persistedOldStore.myUser.myName;
      }
    }
    if (!displayNameForSignIn) {
      displayNameForSignIn = '';
    }
    if (phoneNumberForSignInAnonymously) {
      user.updateProfile({
        displayName: 'Anonymous Test user',
        photoURL: null
      });
    }
    const phoneNumber = user.phoneNumber
      ? user.phoneNumber
      : phoneNumberForSignInAnonymously;

    Raven.setUserContext({
      phoneNumber: phoneNumber,
      countryCode: myCountryCodeForSignInWithPhoneNumber,
      userId: uid
    });

    updatePrivateFieldsAfterLogin(uid, phoneNumber);
    dispatch({
      setMyUser: {
        myName: displayNameForSignIn,
        myUserId: uid,
        myCountryCode: myCountryCodeForSignInWithPhoneNumber,
        myPhoneNumber: phoneNumber
      }
    });
    // I can only listen to matches after I got the games list (because I convert gameSpecId to gameInfo).
    const canListToMatches = store.getState().gamesList.length > 0;
    if (canListToMatches) {
      listenToMyMatchesList();
    }
    fetchGamesList().then(() => {
      if (!canListToMatches) {
        listenToMyMatchesList();
      }
    });
    listenToSignals();
    if (resolveAfterLoginForTests) {
      resolveAfterLoginForTests();
    }
  }

  function updatePrivateFieldsAfterLogin(uid: string, phoneNumber: string) {
    const updates: AnyIndexer = {};
    updates['privateFields/createdOn'] = getTimestamp(); // It's actually "last logged in on timestamp"
    updates['privateFields/phoneNumber'] = phoneNumber;
    updates[
      'privateFields/countryCode'
    ] = myCountryCodeForSignInWithPhoneNumber;
    updates['publicFields/displayName'] = displayNameForSignIn;
    refUpdate(getRef(`/gamePortal/gamePortalUsers/${uid}`), updates);

    const phoneNumberFbr: fbr.PhoneNumber = {
      userId: uid,
      timestamp: getTimestamp()
    };
    if (phoneNumber) {
      checkPhoneNum(phoneNumber);
      refSet(
        getRef(`/gamePortal/phoneNumberToUserId/${phoneNumber}`),
        phoneNumberFbr
      );
    }
  }

  export function checkPhoneNum(phoneNum: string) {
    const isValidNum = /^[+][0-9]{5,20}$/.test(phoneNum);
    checkCondition('phone num', isValidNum);
  }

  // Eventually dispatches the action setGamesList.
  function fetchGamesList() {
    assertLoggedIn();
    return getOnce('/gamePortal/gamesInfoAndSpec/gameInfos').then(
      (gameInfos: fbr.GameInfos) => {
        if (!gameInfos) {
          throw new Error('no games!');
        }
        const gameList: GameInfo[] = getValues(gameInfos).map(gameInfoFbr => {
          const screenShotImage = gameInfoFbr.screenShotImage;
          const gameInfo: GameInfo = {
            gameSpecId: gameInfoFbr.gameSpecId,
            gameName: gameInfoFbr.gameName,
            screenShot: convertImage(
              gameInfoFbr.screenShotImageId,
              screenShotImage
            )
          };
          return gameInfo;
        });
        gameList.sort((g1, g2) => g1.gameName.localeCompare(g2.gameName));
        dispatch({ setGamesList: gameList });
      }
    );
  }

  // Eventually dispatches the action updateGameSpecs.
  const isFetchingGameSpec: BooleanIndexer = {};
  export function fetchGameSpec(game: GameInfo) {
    const gameSpecId = game.gameSpecId;
    assertLoggedIn();
    if (store.getState().gameSpecs.gameSpecIdToGameSpec[gameSpecId]) {
      return;
    }
    if (isFetchingGameSpec[gameSpecId]) {
      return;
    }
    if (!isTests) {
      console.log('fetchGameSpec:', gameSpecId);
    }
    isFetchingGameSpec[gameSpecId] = true;
    getOnce(
      `/gamePortal/gamesInfoAndSpec/gameSpecsForPortal/${gameSpecId}`
    ).then((gameSpecF: fbr.GameSpecForPortal) => {
      if (!isTests) {
        console.log('Got game spec for:', game);
      }
      if (!gameSpecF) {
        throw new Error('no game spec!');
      }
      const action: Action = {
        updateGameSpecs: convertGameSpecForPortal(gameSpecId, gameSpecF)
      };
      dispatch(action);
    });
  }

  function convertGameSpecForPortal(
    gameSpecId: string,
    gameSpecF: fbr.GameSpecForPortal
  ): GameSpecs {
    const { images, elements, gameSpec } = gameSpecF;
    const imageIdToImage: ImageIdToImage = objectMap(
      images,
      (img: fbr.Image, imageId: string) => convertImage(imageId, img)
    );
    let elementIdToElement: ElementIdToElement = objectMap(
      elements,
      (element: fbr.Element, elementId: string) =>
        convertElement(elementId, element, imageIdToImage)
    );

    const gameSpecIdToGameSpec: GameSpecIdToGameSpec = {
      [gameSpecId]: convertGameSpec(
        gameSpecId,
        gameSpec,
        imageIdToImage,
        elementIdToElement
      )
    };
    return {
      imageIdToImage: imageIdToImage,
      elementIdToElement: elementIdToElement,
      gameSpecIdToGameSpec: gameSpecIdToGameSpec
    };
  }
  function convertObjectToArray<T>(obj: IdIndexer<T>): T[] {
    let vals: T[] = [];
    let count = 0;
    for (let [key, val] of Object.entries(obj)) {
      checkCondition('index is int', /^(0|[1-9]\d*)$/.test(key));
      checkCondition('no duplicate index', !(key in vals));
      vals[Number(key)] = val;
      count++;
    }
    checkCondition('no missing index', count === vals.length);
    return vals;
  }
  function convertImage(imageId: string, img: fbr.Image): Image {
    checkCondition('compressed', img.cloudStoragePath.startsWith('compressed'));
    return {
      imageId: imageId,
      height: img.height,
      width: img.width,
      isBoardImage: img.isBoardImage,
      downloadURL: img.downloadURL
    };
  }
  function convertElement(
    elementId: string,
    element: fbr.Element,
    imgs: ImageIdToImage
  ): Element {
    return {
      elementId: elementId,
      height: element.height,
      width: element.width,
      elementKind: element.elementKind,
      images: convertObjectToArray(element.images).map(elementImage =>
        checkNotNull(imgs[elementImage.imageId])
      ),
      isDraggable: element.isDraggable
    };
  }
  function convertPiece(piece: fbr.Piece, elements: ElementIdToElement): Piece {
    return {
      deckPieceIndex: piece.deckPieceIndex,
      element: checkNotNull(elements[piece.pieceElementId]),
      initialState: convertFbrPieceState(piece.initialState)
    };
  }
  function convertGameSpec(
    gameSpecId: string,
    gameSpec: fbr.GameSpec,
    imgs: ImageIdToImage,
    elements: ElementIdToElement
  ): GameSpec {
    return {
      gameSpecId: gameSpecId,
      board: checkNotNull(imgs[gameSpec.board.imageId]),
      pieces: convertObjectToArray(gameSpec.pieces).map(piece =>
        convertPiece(piece, elements)
      )
    };
  }

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

  function findGameInfo(gameSpecId: string): GameInfo {
    const game: GameInfo | undefined = store
      .getState()
      .gamesList.find(gameInList => gameInList.gameSpecId === gameSpecId);
    if (!game) {
      console.warn('missing gameSpecId for match', game);
    }
    return game!;
  }

  export function listenToMatch(matchId: string) {
    checkCondition(
      'listeningToMatchIds',
      listeningToMatchIds.indexOf(matchId) === -1
    );
    listeningToMatchIds.push(matchId);
    return getRef('/gamePortal/matches/' + matchId).on('value', snap => {
      if (!snap) {
        return;
      }
      const matchFb: fbr.Match = snap.val();
      if (!matchFb) {
        return;
      }
      const gameSpecId = matchFb.gameSpecId;
      const newMatchStates = convertPiecesStateToMatchState(
        matchFb.pieces,
        gameSpecId
      );
      const participants = matchFb.participants;
      // Sort by participant's index (ascending participantIndex order)
      const participantsUserIds = Object.keys(participants).sort(
        (uid1, uid2) =>
          participants[uid1].participantIndex -
          participants[uid2].participantIndex
      );
      addMissingUserIdsToContacts(participantsUserIds);

      const gameInfo = checkNotNull(findGameInfo(gameSpecId));
      fetchGameSpec(gameInfo);
      const match: MatchInfo = {
        matchId: matchId,
        gameSpecId: gameSpecId,
        game: gameInfo,
        participantsUserIds: participantsUserIds,
        lastUpdatedOn: matchFb.lastUpdatedOn,
        matchState: newMatchStates
      };

      receivedMatches[matchId] = match;
      if (Object.keys(receivedMatches).length >= listeningToMatchIds.length) {
        dispatchSetMatchesList();
      }
    });
  }

  const fetchedDisplayNameForUserIds: BooleanIndexer = {};
  function fetchDisplayNameForUserId(userId: string) {
    if (fetchedDisplayNameForUserIds[userId]) {
      return;
    }
    fetchedDisplayNameForUserIds[userId] = true;
    getDisplayNameForUserId(userId).then(displayName => {
      addUserInfo(userId, displayName);
    });
  }
  function addMissingUserIdsToContacts(participantsUserIds: string[]) {
    const uid = assertLoggedIn().uid;
    const contacts = store.getState().phoneNumberToContact;
    participantsUserIds.forEach(userId => {
      if (userId !== uid && !contacts[userId]) {
        fetchDisplayNameForUserId(userId);
      }
    });
  }

  function dispatchSetMatchesList() {
    const matches = getValues(receivedMatches);
    // Sort by lastUpdatedOn (descending lastUpdatedOn order).
    matches.sort((a, b) => b.lastUpdatedOn - a.lastUpdatedOn);
    dispatch({ setMatchesList: matches });
  }

  export function createMatch(game: GameInfo) {
    if (!isTests) {
      console.log('createMatch for:', game);
    }
    const uid = getUserId();
    const matchRef = getRef('/gamePortal/matches').push();
    const matchId = matchRef.key!;
    const participants: fbr.Participants = {};
    participants[uid] = {
      participantIndex: 0,
      pingOpponents: getTimestamp()
    };

    const gameSpecId = game.gameSpecId;
    fetchGameSpec(game);

    const newFBMatch: fbr.Match = {
      gameSpecId: gameSpecId,
      participants: participants,
      createdOn: getTimestamp(),
      lastUpdatedOn: getTimestamp(),
      pieces: {}
    };
    refSet(matchRef, newFBMatch);
    addMatchMembership(uid, matchId);

    const newMatch: MatchInfo = {
      matchId: matchId,
      gameSpecId: game.gameSpecId,
      game: game,
      participantsUserIds: [uid],
      lastUpdatedOn: newFBMatch.lastUpdatedOn,
      matchState: []
    };

    receivedMatches[newMatch.matchId] = newMatch;
    dispatchSetMatchesList();
    const matchIndex = store.getState().matchesList.indexOf(newMatch);
    checkCondition('matchIndex', matchIndex >= 0);
    return newMatch;
  }

  export function addMatchMembership(toUserId: string, matchId: string) {
    const matchMembership: fbr.MatchMembership = {
      addedByUid: getUserId(),
      timestamp: getTimestamp()
    };
    const matchMemberships: fbr.MatchMemberships = {
      [matchId]: matchMembership
    };
    refUpdate(getMatchMembershipsRef(toUserId), matchMemberships);
  }

  const MAX_USERS_IN_MATCH = 8;
  export function addParticipant(match: MatchInfo, userId: string) {
    checkCondition(
      'addParticipant',
      match.participantsUserIds.indexOf(userId) === -1
    );
    checkCondition(
      'MAX_USERS_IN_MATCH',
      match.participantsUserIds.length < MAX_USERS_IN_MATCH
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

  // Call this after resetting a match or shuffling a deck.
  export function updateMatchState(match: MatchInfo) {
    const matchState: MatchState = match.matchState;
    checkCondition('updateMatchState', matchState.length > 0);
    const updates: AnyIndexer = {};
    updates['pieces'] = convertMatchStateToPiecesState(
      matchState,
      match.gameSpecId
    );
    updates['lastUpdatedOn'] = getTimestamp();
    refUpdate(getRef(`/gamePortal/matches/${match.matchId}`), updates);
  }

  // Call this after updating a single piece.
  export function updatePieceState(match: MatchInfo, pieceIndex: number) {
    console.log('updatePieceState');
    const pieceState: PieceState = match.matchState[pieceIndex];
    const updates: AnyIndexer = {};
    updates[`pieces/${pieceIndex}`] = convertPieceState(pieceState);
    updates['lastUpdatedOn'] = getTimestamp();
    refUpdate(getRef(`/gamePortal/matches/${match.matchId}`), updates);
  }

  export function checkMatchState(matchState: MatchState, gameSpecId: string) {
    checkMatchStateInStore(matchState, gameSpecId, store.getState());
  }

  function convertPiecesStateToMatchState(
    piecesState: fbr.PiecesState,
    gameSpecId: string
  ): MatchState {
    if (!piecesState) {
      return [];
    }
    const newMatchStates: MatchState = convertObjectToArray(piecesState).map(
      state => convertFbrPieceState(state.currentState)
    );
    checkMatchState(newMatchStates, gameSpecId);
    return newMatchStates;
  }

  function convertFbrPieceState(pieceState: fbr.CurrentState): PieceState {
    const cardVisibilityPerIndex: CardVisibility = {};
    if (pieceState.cardVisibility) {
      for (let visibleToIndex of Object.keys(pieceState.cardVisibility)) {
        cardVisibilityPerIndex[visibleToIndex] = true;
      }
    }
    return {
      x: pieceState.x,
      y: pieceState.y,
      zDepth: pieceState.zDepth,
      currentImageIndex: pieceState.currentImageIndex,
      cardVisibilityPerIndex: cardVisibilityPerIndex
    };
  }
  function validateInteger(
    num: number,
    fromInclusive: number,
    toInclusive: number
  ) {
    return validateNumber(num, fromInclusive, toInclusive, true);
  }
  function validateNumber(
    num: number,
    fromInclusive: number,
    toInclusive: number,
    isInteger: boolean = false
  ) {
    if (isInteger) {
      checkCondition(arguments, num % 1 === 0.0);
    }
    checkCondition(
      arguments,
      typeof num === 'number' && num >= fromInclusive && num <= toInclusive
    );
  }
  function convertPieceState(pieceState: PieceState): fbr.PieceState {
    validateNumber(pieceState.x, -100, 100);
    validateNumber(pieceState.y, -100, 100);
    validateNumber(pieceState.zDepth, 1, 100000000000000000);
    validateInteger(pieceState.currentImageIndex, 0, 256);
    return {
      currentState: {
        x: pieceState.x,
        y: pieceState.y,
        zDepth: pieceState.zDepth,
        currentImageIndex: pieceState.currentImageIndex,
        cardVisibility: pieceState.cardVisibilityPerIndex,
        rotationDegrees: 360,
        drawing: {}
      }
    };
  }
  function convertMatchStateToPiecesState(
    matchState: MatchState,
    gameSpecId: string
  ): fbr.PiecesState {
    const piecesState: fbr.PiecesState = {};
    checkMatchState(matchState, gameSpecId);
    let pieceIndex = 0;
    for (let pieceState of matchState) {
      piecesState[pieceIndex] = convertPieceState(pieceState);
      pieceIndex++;
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

  function storeContactsAfterLogin() {
    const uid = getUserId();
    const currentContacts = checkNotNull(contactsToBeStored!);
    const currentPhoneNumbers = Object.keys(currentContacts);
    currentPhoneNumbers.forEach(phoneNumber => checkPhoneNum(phoneNumber));
    // Max contactName is 20 chars
    currentPhoneNumbers.forEach(phoneNumber => {
      const contact = currentContacts[phoneNumber];
      if (contact.name.length > 17) {
        contact.name = contact.name.substr(0, 17) + '…';
      }
      if (contact.name.length === 0) {
        contact.name = UNKNOWN_NAME;
      }
    });
    const state = store.getState();

    // Mapping phone number to userId for those numbers that don't have a userId.
    const phoneNumberToInfo = getPhoneNumberToUserInfo(state.userIdToInfo);
    const numbersWithoutUserId = currentPhoneNumbers.filter(
      phoneNumber => phoneNumberToInfo[phoneNumber] === undefined
    );
    mapPhoneNumbersToUserIds(numbersWithoutUserId);

    const updates: AnyIndexer = {};
    const oldContacts = state.phoneNumberToContact;
    currentPhoneNumbers.forEach(phoneNumber => {
      const currentContact = currentContacts[phoneNumber];
      const oldContact = oldContacts[phoneNumber];
      if (!oldContact) {
        updates[`${phoneNumber}`] = { contactName: currentContact.name };
      } else if (currentContact.name !== oldContact.name) {
        updates[`${phoneNumber}/contactName`] = currentContact.name;
      }
    });
    if (Object.keys(updates).length > 0) {
      refUpdate(
        getRef(`/gamePortal/gamePortalUsers/${uid}/privateFields/contacts`),
        updates
      );
    }

    dispatch({ updatePhoneNumberToContact: currentContacts });
  }

  function mapPhoneNumbersToUserIds(phoneNumbers: string[]) {
    const userIdToInfo: UserIdToInfo = {};
    const promises: Promise<void>[] = [];
    phoneNumbers.forEach((phoneNumber: string) => {
      promises.push(addToUserIdToInfo(userIdToInfo, phoneNumber));
    });
    Promise.all(promises).then(() => {
      dispatch({ updateUserIdToInfo: userIdToInfo });
    });
  }

  function addToUserIdToInfo(
    userIdToInfo: UserIdToInfo,
    phoneNumber: string
  ): Promise<void> {
    return getUserIdFromPhoneNumber(phoneNumber).then(userId => {
      if (!userId) {
        return;
      }
      // Note that users may have their own number in their contacts.
      // I don't want to exclude it here because then that number will show up in contactsList under "Invite".
      userIdToInfo[userId] = {
        phoneNumber,
        displayName: '',
        userId
      };
    });
  }

  function addUserInfo(userId: string, displayName: string) {
    const userIdInfo: UserIdToInfo = {
      [userId]: { userId, displayName }
    };

    dispatch({ updateUserIdToInfo: userIdInfo });
  }

  export function searchPhoneNumber(
    phoneNumber: string
  ): Promise<ContactWithUserId | null> {
    return getUserIdFromPhoneNumber(phoneNumber).then(userId => {
      if (!userId) {
        return null;
      }
      let promise: Promise<ContactWithUserId | null> = getDisplayNameForUserId(
        userId
      ).then(displayName => {
        addUserInfo(userId, displayName);
        return {
          userId: userId,
          phoneNumber: phoneNumber,
          name: displayName
        };
      });
      return promise;
    });
  }

  function getDisplayNameForUserId(userId: string): Promise<string> {
    return getOnce(
      `/gamePortal/gamePortalUsers/${userId}/publicFields/displayName`
    ).then(displayName => displayName || UNKNOWN_NAME);
  }

  function getUserIdFromPhoneNumber(
    phoneNumber: string
  ): Promise<string | null> {
    checkPhoneNum(phoneNumber);
    return getOnce(`/gamePortal/phoneNumberToUserId/` + phoneNumber).then(
      (phoneNumberFbrObj: fbr.PhoneNumber) => {
        if (!phoneNumberFbrObj) {
          return null;
        }
        return phoneNumberFbrObj.userId;
      }
    );
  }

  // Dispatches setSignals.
  function listenToSignals() {
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
      let updates: AnyIndexer = {};
      Object.keys(signalsFbr).forEach(entryId => {
        updates[entryId] = null;
        const signalFbr: fbr.SignalEntry = signalsFbr[entryId];
        const signal: SignalEntry = signalFbr;
        signals.push(signal);
      });

      // Deleting the signals we got from firebase.
      refUpdate(ref, updates);

      // filtering old signals isn't needed.
      // const now = new Date().getTime();
      // const fiveMinAgo = now - 5 * 60 * 1000;
      // signals = signals.filter(signal => fiveMinAgo <= signal.timestamp);

      // Sorting: oldest entries are at the beginning
      signals.sort((signal1, signal2) => signal1.timestamp - signal2.timestamp);

      dispatch({ setSignals: signals });
    });
  }

  export function sendSignal(
    toUserId: string,
    signalType: 'sdp1' | 'sdp2' | 'candidate',
    signalData: string
  ) {
    checkCondition('sendSignal', signalData.length < 10000);
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
    // If we disconnect, cleanup the signal.
    signalFbrRef.onDisconnect().remove();
  }

  export function addFcmToken(
    fcmToken: string,
    platform: 'web' | 'ios' | 'android'
  ) {
    checkCondition('addFcmToken', /^.{140,200}$/.test(fcmToken));
    // Can be called multiple times if the token is updated.
    const fcmTokenObj: fbr.FcmToken = {
      lastTimeReceived: <any>firebase.database.ServerValue.TIMESTAMP,
      platform: platform
    };
    console.log(getUserId() + ' This is the user id');
    refSet(
      getRef(
        `/gamePortal/gamePortalUsers/${getUserId()}/privateFields/fcmTokens/${fcmToken}`
      ),
      fcmTokenObj
    );
  }

  function addPromiseForTests(promise: Promise<any>) {
    if (allPromisesForTests) {
      allPromisesForTests.push(promise);
    }
    return promise;
  }

  function getOnce(path: string): Promise<any> {
    const promise = getRef(path)
      .once('value')
      .then(snap => {
        if (!snap) {
          return null;
        }
        return snap.val();
      })
      .catch(() => {
        console.warn('Failed fetching ref=', path);
        return null;
      });
    addPromiseForTests(promise);
    return promise;
  }

  function refSet(ref: firebase.database.Reference, val: any) {
    addPromiseForTests(ref.set(val, getOnComplete(ref, val)));
  }

  function refUpdate(ref: firebase.database.Reference, val: AnyIndexer) {
    addPromiseForTests(ref.update(val, getOnComplete(ref, val)));
  }

  function getOnComplete(ref: firebase.database.Reference, val: any) {
    // console.log('Setting ref=', ref.toString(), " to value=", prettyJson(val));
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
